import { Writable } from "node:stream";

import Dockerode from "dockerode";

import { BRAND, DOCKER_LABEL, containerName } from "@ahtapot/shared";

/**
 * Agent konteyneri yaşam döngüsü — dockerode üzerinden.
 *
 * `engine/` Docker'ı bilmez; bu modül `exec/` arayüzüdür. Konteyner iş boyunca
 * ayakta kalır (SDK oturumu ve transcript içeride), kimlik devri onu öldürmez.
 *
 * Sertleştirme DevAgent'tan aynen: `--cap-drop ALL`, `no-new-privileges`,
 * pids/mem/cpu tavanı, docker.sock ASLA mount edilmez. Egress allowlist
 * Linux'a özgü (ipset/iptables); Windows'ta uygulanmaz — R3, bilinçli kabul.
 */

export interface ContainerSpec {
  jobId: string;
  image: string;
  /**
   * İş dizinini taşıyan named volume; konteynerde `workdir`e mount edilir.
   *
   * ÖNCEDEN host yoluydu (bind mount). Windows'ta bu, her dosya erişimini
   * NTFS → WSL2 (9p) → konteyner zincirinden geçiriyordu: Vite gibi on
   * binlerce küçük dosya okuyan araçlarda Northwind web build'i 30 dakikaya
   * çıktı (ölçüldü 2026-09-17). Named volume ext4'te yaşar, o zincir yok.
   */
  jobVolume: string;
  workdir: string;
  /**
   * Kaynak workspace'in host yolu — SALT OKUNUR bağlanır.
   *
   * Mirror'ın fetch kaynağı ve `ignoredButNeeded` kopyalamasının kaynağı
   * budur. Salt okunur olması "kullanıcının checkout'una dokunulmaz" kuralını
   * FS düzeyinde garanti eder; kod hatası bile yazamaz.
   */
  sourceRoot?: string;
  /** Kaynak workspace'in konteynerdeki yeri. */
  sourceMount?: string;
  /**
   * İş açma formunun ekleri (`<artifactsDir>/<jobId>/resources`) — SALT OKUNUR.
   *
   * Worktree'nin (named volume) İÇİNE kopyalamak yerine ayrı bir bind: ekler
   * git ağacının parçası değil, Planner'ın yalnız OKUYACAĞI referans malzeme.
   */
  resourcesRoot?: string;
  /** Eklerin konteynerdeki yeri. */
  resourcesMount?: string;
  /**
   * Ek SALT OKUNUR host bağlamaları — işe bağlı emsal yolları. Konteyner
   * yalnız burada açıkça sayılan host yollarını görür (`--cap-drop ALL`);
   * yazılabilir bağlama bu yoldan asla verilmez.
   */
  readOnlyBinds?: { source: string; target: string }[];
  resources: { memory: string; cpus: string; pidsLimit: number };
  caches: { volume: string; mountPath: string }[];
  env: Record<string, string>;
  bridgeUrl: string;
  bridgeToken: string;
}

/** İş dizinini taşıyan named volume adı. Kira değeri de budur. */
export function jobVolumeName(jobId: string): string {
  return `${BRAND.slug}-job-${jobId}`;
}

export interface OwnedContainer {
  id: string;
  jobId: string;
  name: string;
  state: string;
}

/** "8g" → bayt. Docker'ın kendi biçimi; yanlış birim sessizce 0 olmasın diye sıkı. */
export function parseMemory(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(input.trim());
  if (!m) throw new Error(`bellek biçimi anlaşılmadı: ${input}`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const factor = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[unit] ?? 1;
  return Math.round(n * factor);
}

/** "4" ya da "0.5" → NanoCpus. */
export function parseCpus(input: string): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`cpu biçimi anlaşılmadı: ${input}`);
  return Math.round(n * 1e9);
}

/** Windows yolu Docker Desktop'a ileri eğik çizgiyle gider; `E:\\x` reddediliyor. */
export function toDockerPath(hostPath: string): string {
  return hostPath.replace(/\\/g, "/");
}

export class ContainerManager {
  constructor(private readonly docker: Dockerode = new Dockerode()) {}

  /**
   * Son `available()` çağrısının GERÇEK hatası — `ping()` başarısızsa burada
   * durur. `available()` kendisi `boolean` döndürmek zorunda (çağıranların
   * çoğu yalnız "var mı" sorusuyla ilgileniyor), ama hatayı tamamen yutmak
   * teşhisi imkânsız kılıyordu: kullanıcı yalnız jenerik "Docker erişilemiyor"
   * görüyordu, kök neden (EACCES — docker.sock GID host'a göre değişir ve
   * `node` kullanıcısı yanlış gruba düşebilir, YAŞANDI 2026-09-19) hiçbir
   * yere yazılmıyordu.
   */
  lastError: string | null = null;

  async available(): Promise<boolean> {
    try {
      await this.docker.ping();
      this.lastError = null;
      return true;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * İmajın içinde komut var mı? Kısa ömürlü bir konteynerde `command -v`.
   *
   * İmajın VARLIĞI yetmiyordu: profil `ahtapot/agent-base`i gösteriyordu, imaj
   * vardı, `dotnet` yoktu ve iş kurulum dakikalarca koştuktan sonra **çıkış
   * 127** ile düştü (ölçüldü, 2026-09-16).
   *
   * `--entrypoint sh`: taban imajın ENTRYPOINT'i köprüyü başlatır ve köprü
   * URL'si olmadan hemen çıkar — denetim ona takılmasın.
   */
  async imageHasCommand(image: string, command: string): Promise<boolean> {
    // Komut adı kabuğa gidiyor: yalnız zararsız biçimi geçir.
    if (!/^[A-Za-z][A-Za-z0-9_.+-]*$/.test(command)) return false;
    // Çıktı ilgilendirmiyor, yalnız çıkış kodu; akış zorunlu olduğu için yutulur.
    const sink = new Writable({ write(_c, _e, cb) { cb(); } });
    try {
      const [result] = await this.docker.run(image, ["-c", `command -v ${command}`], sink, {
        Entrypoint: ["sh"],
        HostConfig: { AutoRemove: true, NetworkMode: "none" },
      });
      return (result as { StatusCode?: number }).StatusCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Konteyneri kurar ya da var olanı ayağa kaldırır — idempotent.
   *
   * Aynı iş için ikinci çağrı yeni konteyner yaratmaz: SDK oturumu içeride,
   * yeniden yaratmak `resume`u koparır.
   */
  async ensure(spec: ContainerSpec): Promise<{ id: string; created: boolean }> {
    const name = containerName.agent(spec.jobId);
    const existing = await this.findByName(name);
    if (existing) {
      const info = await existing.inspect();
      if (!info.State.Running) await existing.start();
      return { id: info.Id, created: false };
    }

    const env = Object.entries({
      ...spec.env,
      AHTAPOT_JOB_ID: spec.jobId,
      AHTAPOT_BRIDGE_URL: spec.bridgeUrl,
      AHTAPOT_BRIDGE_TOKEN: spec.bridgeToken,
      // Transcript VOLUME'de kalıcı: konteyner yeniden yaratılsa bile resume
      // çalışır. Volume silinirse transcript de gider — o durumda `resume`
      // "No conversation found" der ve runner oturumsuz yeniden dener.
      CLAUDE_CONFIG_DIR: `${spec.workdir}/.${BRAND.slug}/claude`,
    }).map(([k, v]) => `${k}=${v}`);

    // Kimlik ASLA burada değil: köprü onu bağlandıktan sonra `identity.set` ile alır.
    for (const forbidden of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      if (forbidden in spec.env) throw new Error(`kimlik konteyner ortamına yazılamaz: ${forbidden}`);
    }

    const container = await this.docker.createContainer({
      name,
      Image: spec.image,
      Env: env,
      WorkingDir: spec.workdir,
      Labels: { [DOCKER_LABEL.job]: spec.jobId, [DOCKER_LABEL.role]: "agent" },
      HostConfig: {
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        PidsLimit: spec.resources.pidsLimit,
        Memory: parseMemory(spec.resources.memory),
        NanoCpus: parseCpus(spec.resources.cpus),
        Mounts: [
          { Type: "volume", Source: spec.jobVolume, Target: spec.workdir },
          // Kaynak workspace salt okunur: mirror buradan fetch eder, gitignore'lu
          // içerik buradan kopyalanır, ama hiçbir koşulda yazılamaz.
          ...(spec.sourceRoot && spec.sourceMount
            ? [{
                Type: "bind" as const,
                Source: toDockerPath(spec.sourceRoot),
                Target: spec.sourceMount,
                ReadOnly: true,
              }]
            : []),
          ...(spec.resourcesRoot && spec.resourcesMount
            ? [{
                Type: "bind" as const,
                Source: toDockerPath(spec.resourcesRoot),
                Target: spec.resourcesMount,
                ReadOnly: true,
              }]
            : []),
          ...(spec.readOnlyBinds ?? []).map((b) => ({
            Type: "bind" as const,
            Source: toDockerPath(b.source),
            Target: b.target,
            ReadOnly: true,
          })),
          ...spec.caches.map((c) => ({ Type: "volume" as const, Source: c.volume, Target: c.mountPath })),
        ],
        // Linux sunucuda host'a erişim için gerekli; Docker Desktop zaten çözer.
        ExtraHosts: ["host.docker.internal:host-gateway"],
        RestartPolicy: { Name: "no" },
        LogConfig: { Type: "json-file", Config: { "max-size": "20m", "max-file": "2" } },
      },
    });
    await container.start();
    return { id: container.id, created: true };
  }

  async stop(jobId: string, timeoutSeconds = 10): Promise<boolean> {
    const c = await this.findByName(containerName.agent(jobId));
    if (!c) return false;
    await c.stop({ t: timeoutSeconds }).catch(() => {
      // Zaten durmuşsa 304 döner; hata değil.
    });
    return true;
  }

  async remove(jobId: string): Promise<boolean> {
    const c = await this.findByName(containerName.agent(jobId));
    if (!c) return false;
    await c.remove({ force: true });
    return true;
  }

  /**
   * İş volume'ünü kaldırır — konteyner gittikten SONRA çağrılmalı.
   *
   * Kullanımdaki volume Docker tarafından reddedilir (409); bu sessiz geçilir,
   * çünkü çağıran zaten konteyneri kaldırmış olmalıydı ve zorlamak veriyi
   * kaybettirir. Yoksa (404) da hata değil — idempotent olmalı.
   */
  async removeVolume(jobId: string): Promise<boolean> {
    try {
      await this.docker.getVolume(jobVolumeName(jobId)).remove();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Volume'ü yoksa yaratır. `ensure()` zaten yaratırdı (Docker mount ederken
   * otomatik yapar), ama worktree hazırlığı konteynerden ÖNCE volume'e ihtiyaç
   * duymaz — yine de açıkça yaratmak, etiketin yazılmasını garanti eder:
   * `reconcile()` yetim volume'leri etiketle bulur.
   *
   * `workdir` verilirse sahiplik de düzeltilir — bkz. `chownVolume`.
   */
  async ensureVolume(jobId: string, workdir?: string, image?: string): Promise<string> {
    const name = jobVolumeName(jobId);
    await this.docker
      .createVolume({ Name: name, Labels: { [DOCKER_LABEL.job]: jobId, [DOCKER_LABEL.role]: "worktree" } })
      .catch(() => {
        // Zaten varsa Docker aynı volume'ü döndürür; yarışta ikinci çağrı düşerse de sorun yok.
      });
    if (workdir && image) await this.chownVolume(name, workdir, image);
    return name;
  }

  /**
   * Mount noktasının sahibini `node` yapar — boş volume'da bir kez.
   *
   * YAŞANDI (2026-09-21): Docker, named volume'u imajda VAR OLMAYAN bir yola
   * mount ederken o dizini **root:root 755** yaratır. Konteyner `node` olarak
   * koşuyor (docker/agent/Dockerfile), dolayısıyla oraya yazamıyor. SDK
   * açılışta `CLAUDE_CONFIG_DIR`e (`<workdir>/.ahtapot/claude`, bkz. `ensure`)
   * yazmak zorunda; `mkdir` "Permission denied" ile düşüyor ve SDK bunu
   * "native binary ... failed to launch / libc uyuşmazlığı" diye raporluyor.
   * Mesaj tamamen yanıltıcı — binary sağlam, sorun dosya izni. Bir günlük
   * teşhis bu yanlış ize harcandı.
   *
   * `workdir` imaja gömülemez: profilin kararıdır (`exec.workdir`) ve motor
   * onu bilmeden çalışmalı. Bu yüzden düzeltme imajda değil burada.
   *
   * YALNIZ BOŞ VOLUME'DA koşar: dolu bir worktree'de her `acquire`da
   * `chown -R` gezmek binlerce dosyada ölçülebilir bir gecikme, üstelik
   * gereksiz — sahiplik ilk yaratılışta bir kez bozuluyor.
   *
   * MOUNT NOKTASINI TEK BAŞINA `chown`LAMAK YETMEZ (ölçüldü): Docker, BOŞ bir
   * volume'ün kök dizininin sahipliğini her mount'ta imajdaki hedef dizinden
   * yeniden türetiyor, yani ilk konteynerde `node:node` yapılan dizin ikinci
   * konteynerde yine `root:root` geliyordu. Volume'ün İÇİNE bir dizin yaratmak
   * onu "boş değil" yapar ve sahiplik kalıcı olur — `worktrees` zaten akışın
   * ilk ihtiyaç duyduğu alt dizin (bkz. `runtime.ts`, `<workdir>/worktrees/...`).
   *
   * FIRLATMAZ: sahiplik zaten doğruysa ya da `chown` bir nedenle düşerse iş
   * durmamalı. Gerçek hata birkaç saniye sonra, konteynerin kendi akışında ve
   * daha anlaşılır biçimde yüzeye çıkar.
   */
  private async chownVolume(volume: string, workdir: string, image: string): Promise<void> {
    // Yol kabuğa gidiyor: yalnız zararsız biçimi geçir (boşluk, tırnak, `$` yok).
    if (!/^\/[A-Za-z0-9_./-]*$/.test(workdir)) return;
    const sink = new Writable({ write(_c, _e, cb) { cb(); } });
    try {
      // `-u 0`: chown için kök gerekli. Konteyner saniyeler yaşar, ağı yok ve
      // AutoRemove ile silinir — kalıcı kök yetkisi taşınmaz.
      //
      // Volume doluysa hiç dokunulmaz: `-mindepth 1 -quit` ilk dosyada durur,
      // `chown -R` binlerce dosyayı gezmeye hiç başlamaz.
      const script =
        `[ -z "$(find ${workdir} -mindepth 1 -print -quit 2>/dev/null)" ] && ` +
        `mkdir -p ${workdir}/worktrees && chown -R node:node ${workdir} || true`;
      await this.docker.run(
        image,
        ["-c", script],
        sink,
        {
          Entrypoint: ["sh"],
          User: "0",
          HostConfig: {
            AutoRemove: true,
            NetworkMode: "none",
            Mounts: [{ Type: "volume", Source: volume, Target: workdir }],
          },
        },
      );
    } catch {
      // Yukarıdaki gerekçe: sahiplik düzeltilemezse de iş denenmeli.
    }
  }

  /** Bu kurulumun etiketini taşıyan iş volume'leri — `reconcile()` için. */
  async listOwnedVolumes(): Promise<{ name: string; jobId: string }[]> {
    const res = (await this.docker.listVolumes({
      filters: { label: [`${DOCKER_LABEL.role}=worktree`] },
    })) as { Volumes?: { Name: string; Labels?: Record<string, string> }[] };
    return (res.Volumes ?? []).map((v) => ({
      name: v.Name,
      jobId: v.Labels?.[DOCKER_LABEL.job] ?? "",
    }));
  }

  /** Son N satır log — teşhis için. Köprü sır yazmaz ama yine de maskelenmeli. */
  async logs(jobId: string, tail = 200): Promise<string> {
    const c = await this.findByName(containerName.agent(jobId));
    if (!c) return "";
    const buf = await c.logs({ stdout: true, stderr: true, tail });
    return demux(buf as unknown as Buffer);
  }

  /** İşin konteyneri (exec için); yoksa null. */
  async containerFor(jobId: string): Promise<Dockerode.Container | null> {
    return this.findByName(containerName.agent(jobId));
  }

  /** Bu kurulumun etiketini taşıyan tüm konteynerler — `reconcile()` için. */
  async listOwned(): Promise<OwnedContainer[]> {
    const list = await this.docker.listContainers({
      all: true,
      filters: { label: [`${DOCKER_LABEL.role}=agent`] },
    });
    return list.map((c) => ({
      id: c.Id,
      jobId: c.Labels?.[DOCKER_LABEL.job] ?? "",
      name: c.Names?.[0]?.replace(/^\//, "") ?? "",
      state: c.State ?? "",
    }));
  }

  private async findByName(name: string): Promise<Dockerode.Container | null> {
    const list = await this.docker.listContainers({ all: true, filters: { name: [name] } });
    const hit = list.find((c) => c.Names?.some((n) => n === `/${name}`));
    return hit ? this.docker.getContainer(hit.Id) : null;
  }
}

/** Docker log akışı 8 baytlık çerçeve başlığı taşır; düz metne indir. */
function demux(buf: Buffer): string {
  const parts: string[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + len).toString("utf8"));
    i += 8 + len;
  }
  return parts.join("");
}
