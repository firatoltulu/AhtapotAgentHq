import { basename, dirname } from "node:path";

import Dockerode from "dockerode";

import { BRAND, DOCKER_LABEL, scrubSecrets, serviceByName, type Command, type ProjectProfile, type Service } from "@ahtapot/shared";

import { jobVolumeName, toDockerPath } from "../exec/docker.js";

/**
 * Golden DB — bir kez kur, iş başına klonla.
 *
 * Migration ile seed AYRI adımlardır ve seed atlanamaz: Northwind'de migration
 * yalnız şemayı kurar, tohum (kiracı, roller, izinler) ayrı koddur; tohumsuz
 * DB'de her uç 403 döner, açılışta hata çıkmaz, panel boş gelir.
 *
 * Windows kritik detayı: bind-mount'ta PostgreSQL yavaş. Golden veri named
 * volume'de durur, klon konteyner içinde `cp -a` ile yapılır — host dosya
 * sistemi devreye girmez (ölçüldü: R1, 2-5×).
 *
 * Kurulum: geçici ağ + DB servisi (profil bağımlılığından) + araç konteyneri
 * (profil exec imajı, worktree bind) migrate ve seed'i koşturur. Bittiğinde
 * DB durdurulur, ağ silinir, volume `createdAt` etiketiyle kalır.
 */

export interface GoldenInfo {
  volume: string;
  createdAt: string;
  ageDays: number;
  stale: boolean;
  /** Bu koşuda yeniden kuruldu mu. */
  rebuilt: boolean;
}

export interface GoldenDeps {
  docker?: Dockerode;
  log?: (line: string) => void;
  /** Sağlık yoklaması aralığı/tavanı; testler kısaltır. */
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
}

export class GoldenDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldenDbError";
  }
}

/** Klonu yapan küçük imaj; `cp -a` dışında bir şey istemiyoruz. */
const CLONE_IMAGE = "alpine";

export function goldenVolumeName(slug: string): string {
  return `${BRAND.slug}-golden-${slug}`;
}

export function jobDbVolumeName(jobId: string): string {
  return `${BRAND.slug}-db-${jobId}`;
}

/**
 * Veritabanını taşıyan servis — `database.clone.service` adıyla.
 *
 * Ad BAĞLAYICIDIR: profil hangi servis olduğunu açıkça söylemişken tahmin
 * yürütmek yanlış servisi seçiyordu. Yaşandı: `internalPort` 5432 olmayan
 * (dışarıda 5432, içeride başka) bir Postgres tanımında eski sezgi hiç
 * eşleşmiyor, `pgCredsFrom` `host` alanını boş bırakıyor ve `psql` dış adrese
 * değil konteynerin kendi soketine bağlanmaya çalışıp 120 s boyunca sessizce
 * düşüyordu ("postgres 120 s içinde cevap vermedi").
 *
 * Ad eşleşmezse `null` döner — sessizce başka bir servise düşmek, yanlış
 * veritabanına yazmak demektir.
 */
export function dbDependency(profile: ProjectProfile): Service | null {
  const named = profile.database.clone.service;
  if (named) return serviceByName(profile, named);
  // Ad boş bırakılmışsa eski sezgi: `dataPath` DIŞ serviste anlamsız (veri
  // host'ta durur), o yüzden veri taşıyan servis yoksa dışarıdaki Postgres
  // kabul edilir.
  const all = profile.services;
  return all.find((d) => d.dataPath) ?? all.find((d) => d.externalHost && d.internalPort === 5432) ?? null;
}

export class GoldenDb {
  private readonly docker: Dockerode;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: GoldenDeps = {}) {
    this.docker = deps.docker ?? new Dockerode();
    this.log = deps.log ?? (() => {});
  }

  /**
   * İmajı yerelde yoksa çeker. `createContainer` eksik imajı KENDİLİĞİNDEN
   * çekmez ve "No such image" ile düşer; temiz bir kurulumda golden'ın üç
   * yolu da (DB imajı, araç imajı, alpine) buna takılırdı.
   */
  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      this.log(`imaj çekiliyor: ${image}`);
    }
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  async inspect(slug: string, maxAgeDays: number): Promise<GoldenInfo | null> {
    try {
      const info = await this.docker.getVolume(goldenVolumeName(slug)).inspect();
      const createdAt = info.Labels?.["ahtapot.createdAt"] ?? (info as { CreatedAt?: string }).CreatedAt ?? new Date(0).toISOString();
      const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86_400_000;
      return { volume: info.Name, createdAt, ageDays, stale: ageDays > maxAgeDays, rebuilt: false };
    } catch {
      return null;
    }
  }

  /**
   * Golden'ı hazırlar: yoksa ya da bayatsa kurar. `force` ile her zaman.
   * Bayat golden işi DURDURMAZ; çağıran uyarır ve yeniden kurmayı seçer.
   */
  async ensure(profile: ProjectProfile, worktreePath: string, opts: { force?: boolean; jobId?: string } = {}): Promise<GoldenInfo> {
    const db = profile.database;
    if (db.kind === "none") throw new GoldenDbError("profilde veritabanı tanımlı değil (database.kind = none)");
    const dep = dbDependency(profile);
    if (!dep) throw new GoldenDbError("golden DB için `services[].dataPath` verilmiş bir servis gerekli");
    if (!db.migrate) throw new GoldenDbError("database.migrate komutu yok");

    const existing = await this.inspect(profile.slug, db.goldenMaxAgeDays);
    if (existing && !existing.stale && !opts.force) return existing;
    if (existing) {
      this.log(`golden ${existing.stale ? "bayat" : "yeniden kuruluyor"} (${existing.ageDays.toFixed(1)} gün); siliniyor`);
      await this.docker.getVolume(existing.volume).remove({ force: true });
    }

    const volume = goldenVolumeName(profile.slug);
    const createdAt = new Date().toISOString();
    await this.docker.createVolume({ Name: volume, Labels: { [DOCKER_LABEL.role]: "golden", "ahtapot.createdAt": createdAt, "ahtapot.project": profile.slug } });

    let failed = false;
    const netName = `${BRAND.slug}-golden-${profile.slug}-${Date.now().toString(36)}`;
    const net = await this.docker.createNetwork({ Name: netName, Labels: { [DOCKER_LABEL.role]: "golden" } });
    let dbContainer: Dockerode.Container | null = null;
    try {
      await this.ensureImage(dep.image);
      this.log(`golden: ${dep.name} (${dep.image}) kalkıyor`);
      dbContainer = await this.docker.createContainer({
        name: `${BRAND.slug}-golden-${profile.slug}-db`,
        Image: dep.image,
        Env: Object.entries(dep.env).map(([k, v]) => `${k}=${v}`),
        Labels: { [DOCKER_LABEL.role]: "golden" },
        HostConfig: { Mounts: [{ Type: "volume", Source: volume, Target: dep.dataPath! }], NetworkMode: netName, AutoRemove: false },
        NetworkingConfig: { EndpointsConfig: { [netName]: { Aliases: [dep.name] } } },
      });
      await dbContainer.start();
      await this.waitHealthy(dbContainer, dep.healthCmd);

      // Migration ve seed AYRI adımlar; ikisi de zorunlu (seed varsa).
      await this.runStep(profile, worktreePath, netName, db.migrate, "migrate", opts.jobId);
      if (db.seed) await this.runStep(profile, worktreePath, netName, db.seed, "seed", opts.jobId);
      else this.log("golden: seed komutu yok — tohumsuz DB'de uçlar 403 dönebilir (Northwind dersi)");

      this.log("golden: hazır");
      return { volume, createdAt, ageDays: 0, stale: false, rebuilt: true };
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      if (dbContainer) await dbContainer.remove({ force: true }).catch(() => {});
      await net.remove().catch(() => {});
      // Yarım golden bırakma: bir sonraki iş onu "hazır" sanır. Volume ancak
      // konteyner gittikten sonra silinebilir (Docker kullanımdaki volume'ü
      // force ile bile silmez, 409 döner ve hata yutulurdu).
      if (failed) await this.docker.getVolume(volume).remove({ force: true }).catch(() => {});
    }
  }

  /** Golden'ı iş volume'üne kopyalar — konteyner içinde, host FS'e dokunmadan. */
  async clone(slug: string, jobId: string): Promise<string> {
    const from = goldenVolumeName(slug);
    const to = jobDbVolumeName(jobId);
    await this.docker.getVolume(to).remove({ force: true }).catch(() => {});
    await this.docker.createVolume({ Name: to, Labels: { [DOCKER_LABEL.role]: "live-db", [DOCKER_LABEL.job]: jobId } });
    await this.ensureImage(CLONE_IMAGE);
    await this.runOneOff({
      Image: CLONE_IMAGE,
      Cmd: ["sh", "-c", "cp -a /from/. /to/"],
      HostConfig: { Mounts: [{ Type: "volume", Source: from, Target: "/from", ReadOnly: true }, { Type: "volume", Source: to, Target: "/to" }], AutoRemove: false },
    }, "clone");
    this.log(`golden: iş DB'si klonlandı (${to})`);
    return to;
  }

  async removeJobVolume(jobId: string): Promise<boolean> {
    try {
      await this.docker.getVolume(jobDbVolumeName(jobId)).remove({ force: true });
      return true;
    } catch {
      return false;
    }
  }

  private async waitHealthy(container: Dockerode.Container, healthCmd: string | undefined): Promise<void> {
    const interval = this.deps.healthIntervalMs ?? 2000;
    const timeout = this.deps.healthTimeoutMs ?? 120_000;
    const started = Date.now();
    if (!healthCmd) {
      await new Promise((r) => setTimeout(r, interval * 2));
      return;
    }
    // TEK başarı yetmez: Postgres başlatma betiklerini koşarken soketi açıyor ve
    // `pg_isready` 0 dönüyor, ama o aralıkta bağlantılar reddediliyor — migrate
    // çıkış 2 ile düşüyordu (ölçüldü: golden testi kararsızdı, üç koşuda iki
    // sonuç). Arka arkaya iki başarı, geçici "hazır"ı eler.
    const needed = 2;
    let streak = 0;
    for (;;) {
      const exec = await container.exec({ Cmd: ["sh", "-c", healthCmd], AttachStdout: true, AttachStderr: true });
      const stream = await exec.start({ hijack: true, stdin: false });
      await new Promise<void>((resolve) => { stream.on("data", () => {}); stream.on("end", resolve); stream.on("close", resolve); stream.on("error", resolve); });
      const info = await exec.inspect();
      if (info.ExitCode === 0) {
        if (++streak >= needed) return;
      } else {
        streak = 0; // kesinti: sayaç sıfırdan başlar
      }
      if (Date.now() - started > timeout) throw new GoldenDbError(`golden DB ${timeout / 1000} s içinde sağlıklı olmadı`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  private async runStep(profile: ProjectProfile, worktreePath: string, netName: string, cmd: Command, label: string, jobId?: string): Promise<void> {
    await this.ensureImage(profile.exec.image);
    this.log(`golden/${label}: ${scrubSecrets(cmd.run)}`);
    // MOUNT DÜZENİ AGENT KONTEYNERİYLE AYNI OLMALI.
    //
    // `runtime.ts` İŞ DİZİNİNİ (`jobDir`) `/workspace`e bağlar; repo bir alt
    // dizindir ve konteynerde `/workspace/<repo>` olur. Golden ise worktree'yi
    // doğrudan `/workspace`e bağlıyordu — bir seviye kayık.
    //
    // Sonuç sessiz değildi ama teşhisi zordu: build agent konteynerinde koştuğu
    // için `staticwebassets.runtime.json` içine `/workspace/Northwind/...` yazıldı;
    // golden o manifesti `/workspace/...` düzeninde okuyunca .NET
    // `DirectoryNotFoundException: /workspace/Northwind/Northwind.Host/wwwroot/` ile
    // düştü (yaşandı 2026-09-18). Aynı worktree, iki farklı yol düzeni.
    const repoName = basename(worktreePath);
    const workdir = profile.exec.workdir;
    const repoRoot = `${workdir}/${repoName}`.replace(/\/+/g, "/");
    const cwd = cmd.cwd === "." ? repoRoot : `${repoRoot}/${cmd.cwd}`.replace(/\/+/g, "/");
    const code = await this.runOneOff({
      Image: profile.exec.image,
      // `Entrypoint` EZİLMELİ: taban imajın ENTRYPOINT'i köprüyü başlatıyor ve
      // `Cmd` ona ARGÜMAN olarak geçiyor — migrate komutu hiç koşmuyordu.
      // Köprü `AHTAPOT_BRIDGE_URL` bulamayıp `exit(2)` ediyor ve adım
      // "çıkış 2" ile düşüyordu, tek ipucu logdaki "köprü: ... tanımlı değil"
      // satırıydı (yaşandı 2026-09-18). `docker.ts:imageHasCommand` aynı
      // tuzağı daha önce görmüş ve orada çözülmüştü.
      Entrypoint: ["sh", "-lc"],
      Cmd: [cmd.run],
      WorkingDir: cwd,
      Env: Object.entries({ ...profile.exec.env, ...cmd.env }).map(([k, v]) => `${k}=${v}`),
      // İş dizini named volume: worktree host'ta yok (2026-09-17 taşıması).
      // jobId yoksa mount edilmez — golden adımı worktree görmeden koşar ve
      // komut kendi dosyalarını bulamazsa açıkça düşer (sessiz yanlış çıktıdan
      // iyidir).
      HostConfig: {
        ...(jobId ? { Mounts: [{ Type: "volume" as const, Source: jobVolumeName(jobId), Target: workdir }] } : {}),
        NetworkMode: netName,
        AutoRemove: false,
      },
    }, label, cmd.timeoutMinutes * 60_000);
    if (code !== 0 && !cmd.optional) throw new GoldenDbError(`golden ${label} adımı düştü (çıkış ${code})`);
  }

  /** Tek seferlik konteyner: koştur, çıkışı ve logu al, kaldır. */
  private async runOneOff(spec: Dockerode.ContainerCreateOptions, label: string, timeoutMs = 600_000): Promise<number> {
    const c = await this.docker.createContainer({ ...spec, Labels: { ...(spec.Labels ?? {}), [DOCKER_LABEL.role]: "golden" } });
    let timer: NodeJS.Timeout | null = null;
    try {
      await c.start();
      const waited = await Promise.race([
        c.wait(),
        // Timer TEMİZLENMELİ: yarış bittikten sonra da event loop'u canlı tutar
        // ve süreç (testler dâhil) dakikalarca kapanmaz.
        new Promise<null>((r) => { timer = setTimeout(() => r(null), timeoutMs); }),
      ]);
      if (waited === null) {
        await c.kill().catch(() => {});
        throw new GoldenDbError(`golden ${label} zaman aşımı (${Math.round(timeoutMs / 60_000)} dk)`);
      }
      const logs = await c.logs({ stdout: true, stderr: true, tail: 60 });
      for (const line of demux(logs as unknown as Buffer).split("\n")) if (line.trim()) this.log(`  ${scrubSecrets(line)}`);
      return (waited as { StatusCode: number }).StatusCode;
    } finally {
      if (timer) clearTimeout(timer);
      await c.remove({ force: true }).catch(() => {});
    }
  }
}

/** Docker log/exec akışı 8 baytlık çerçeve başlığı taşır; düz metne indir. */
export function demux(buf: Buffer): string {
  const parts: string[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + len).toString("utf8"));
    i += 8 + len;
  }
  return parts.join("");
}
