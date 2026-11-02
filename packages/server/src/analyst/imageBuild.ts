import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type Dockerode from "dockerode";
import { eq } from "drizzle-orm";

import { BRAND, scrubSecrets } from "@ahtapot/shared";

import { newId, schema, type Db } from "../db/index.js";

/**
 * Profil imajının build'i — Analyst'in ürettiği tarifi etikete çevirir.
 *
 * BUGÜNE KADAR ELLE YAPILIYORDU: biri `docker/<slug>/Dockerfile` yazıyor, biri
 * `docker build` koşuyordu. Bu adım hiçbir yerde kullanıcıya söylenmiyordu —
 * analiz bitiyor, profil onaylanıyor, iş `Planning`e giriyor ve saatler sonra
 * "image not found" ile düşüyordu.
 *
 * Motor Docker tarifi BİLMİYOR: tarif profilde (`exec.dockerfile`) yaşıyor,
 * bu modül yalnız "profildeki tarifi uygula" diyor. Proje-agnostiklik böyle
 * korunuyor.
 */

/** `docker build` çıktısının tek satırı — Docker'ın JSON akış biçimi. */
interface BuildProgressLine {
  stream?: string;
  status?: string;
  error?: string;
  errorDetail?: { message?: string };
}

/**
 * `Docker.prototype.followProgress` — dockerode 5'te VAR ama `@types/dockerode`
 * (4.x) henüz bilmiyor; tipler çalışma zamanının gerisinde.
 *
 * `any` yerine yapısal bir tip (CLAUDE.md): yalnız kullandığımız imza
 * tanımlanır, tip güvenliği çağrı noktasında korunur.
 */
interface FollowsProgress {
  followProgress(
    stream: NodeJS.ReadableStream,
    onFinished: (err: Error | null, output: BuildProgressLine[] | undefined) => void,
    onProgress: (event: BuildProgressLine) => void,
  ): void;
}

export interface ValidateDockerfileResult {
  ok: boolean;
  reason?: string;
}

/**
 * Dockerfile'ın ŞEKLİNİ doğrular — build'den önceki son kapı.
 *
 * Kural 3'ün (üretici taraf güvenilmez) Dockerfile'a uyarlanmış hâli: Zod bir
 * Dockerfile'ı yapısal olarak doğrulayamaz, bu yüzden burada yalnız iki şey
 * aranır ve fazlası ARANMAZ ("her kötülüğü kanıtlamaya çalışma"):
 *
 *  1. Taban imaj `ahtapot/agent-base` olmalı. Taban, Claude Code'u, köprüyü ve
 *     beklenen kullanıcı/dizin düzenini taşır; başka bir tabandan türeyen imaj
 *     ayağa kalkar ama konteyner sessizce çalışmaz.
 *  2. `ADD http(s)://` reddedilir — denetlenemeyen uzak bir indirmeyi imaja
 *     gömmek, tarifi okuyan insanın göremediği bir bağımlılık yaratır.
 *  3. `USER` yalnız `root` ya da `node` olabilir. Taban `node:22-bookworm-slim`
 *     ve tek ayrıcalıksız hesabı `node`.
 *
 *     YAŞANDI (2026-09-20): agent `USER agent` üretti. Build BAŞARIYLA GEÇTİ —
 *     Docker `USER`ı yalnız imaj metadata'sına yazar, o an passwd'de aramaz.
 *     Hata konteyner ÇALIŞTIRILIRKEN çıktı: `planning_failed: (HTTP code 500)
 *     unable to find user agent: no matching entries in passwd file`. Yani
 *     bozuk tarif yeşil build'den geçip saatler sonra ilk işi düşürüyor; kusur
 *     üretildiği yerden uzakta görünüyor. Denetimin burada olmasının sebebi bu.
 *  4. Yerel (`--from=` OLMAYAN) `COPY`/`ADD` reddedilir — build bağlamı
 *     Dockerfile'ın KENDİ DİZİNİDİR (bkz. `buildProfileImage`), workspace'ten
 *     hiçbir dosya oraya konmaz. YAŞANDI (2026-09-20): analyst.md'nin "var olan
 *     Dockerfile'ı aynen kopyala" kuralına uyup motorun kendi
 *     `docker/server/Dockerfile`'ından `COPY agents agents` satırını aynen
 *     devretti; context'te `agents/` hiç yoktu ve build "file not found in
 *     build context" ile düştü. `--from=<stage>` ile çok aşamalı build'in
 *     kendi ürettiği bir ara aşamadan kopyalamak meşru, bu yüzden yalnız o
 *     istisna tutulur.
 *
 * Denetimler FİZİKSEL SATIRA DEĞİL mantıksal komuta uygulanır; bkz.
 * `logicalLines`.
 */
export function validateDockerfileContent(text: string): ValidateDockerfileResult {
  const lines = text.split(/\r?\n/);
  const commands = logicalLines(lines);

  // Yorum ve boş satırlar atlanır; `ARG`ın `FROM`dan önce gelmesi Docker'da
  // meşrudur ama taban imajı değişkenden türetmek denetimi anlamsız kılar —
  // bu yüzden ilk ANLAMLI komut doğrudan `FROM` olmalı.
  const first = commands[0]?.text.trim();
  if (!first) return { ok: false, reason: "Dockerfile boş" };

  if (!/^FROM\s+ahtapot\/agent-base(:[\w.-]+)?(\s+AS\s+\w+)?\s*$/i.test(first)) {
    return {
      ok: false,
      reason: `ilk satır "FROM ahtapot/agent-base" olmalı, bulunan: ${first.slice(0, 80)}`,
    };
  }

  // FİZİKSEL SATIR DEĞİL MANTIKSAL KOMUT denetlenir.
  //
  // Dockerfile ters bölü ile satır devamını destekliyor ve bayraklar sonraki
  // satıra taşınabiliyor. Fiziksel satıra bakan bir denetim, tamamen geçerli
  // olan şu komutu "yerel COPY" sanıp reddediyordu:
  //
  //     COPY \
  //       --from=builder \
  //       /src /dest
  //
  // Doğrulama düştüğünde Dockerfile artifact'ı hiç yazılmıyor ve
  // `exec.dockerfile` boş kalıyor; imaj yoksa profil onayı 409 ile
  // engelleniyor. Yani false-positive'in bedeli, çalışan bir tarifin
  // onaylanamaması.
  for (const cmd of commands) {
    const { text: raw, line: i } = cmd;
    if (/^\s*ADD\s+https?:\/\//i.test(raw)) {
      return { ok: false, reason: `uzak URL'den ADD yasak (satır ${i + 1})` };
    }

    // `USER node:node` ve `USER 1000` gibi biçimler de meşru; ilk parça yeter.
    const user = /^\s*USER\s+(\S+)/i.exec(raw)?.[1];
    if (user !== undefined) {
      const name = user.split(":")[0];
      if (name !== "root" && name !== "node") {
        return {
          ok: false,
          reason: `USER yalnız root ya da node olabilir, bulunan "${user}" (satır ${i + 1}); taban imajda başka kullanıcı yok`,
        };
      }
    }

    // `--from=<stage>` ile kendi ürettiği bir ara aşamadan kopyalamak meşru;
    // onun dışında her COPY/ADD build bağlamından (Dockerfile'ın kendi
    // dizini) okur ve orada workspace'e ait HİÇBİR dosya yoktur.
    const copyOrAdd = /^\s*(COPY|ADD)\s+(.*)$/i.exec(raw);
    if (copyOrAdd && !/--from=/i.test(copyOrAdd[2] ?? "")) {
      return {
        ok: false,
        reason: `yerel COPY/ADD yasak (satır ${i + 1}): build bağlamı yalnız bu Dockerfile'ın kendi dizinidir, workspace'ten dosya kopyalanamaz`,
      };
    }
  }

  return { ok: true };
}

/**
 * Ters bölü ile bölünmüş fiziksel satırları mantıksal komutlara birleştirir.
 *
 * `line` komutun BAŞLADIĞI fiziksel satırdır (0 tabanlı): hata mesajı
 * insanın editöründe göreceği yeri göstermeli, birleştirilmiş metnin sonunu
 * değil.
 *
 * Devam satırının içindeki yorumlar atlanır — Docker da öyle yapıyor ve
 * yorumda satır devamı DESTEKLENMEZ (resmî referans).
 */
function logicalLines(lines: readonly string[]): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let buf: string | null = null;
  let start = 0;
  for (const [i, raw] of lines.entries()) {
    const continued = /\\\s*$/.test(raw);
    const body = continued ? raw.replace(/\\\s*$/, "") : raw;
    if (buf === null) {
      // Yorum ya da boş satır bir komut başlatmaz; devam ediyor olsa bile
      // (yorumda devam karakteri Docker'da işlemez) burada biter.
      if (/^\s*(#|$)/.test(raw)) continue;
      start = i;
      buf = body;
    } else {
      // Devam içindeki yorum satırı yok sayılır, komut devam eder.
      if (/^\s*#/.test(raw)) continue;
      buf += ` ${body.trim()}`;
    }
    if (!continued) {
      out.push({ text: buf, line: start });
      buf = null;
    }
  }
  // Dosya devam karakteriyle bitmişse eldeki komut yine denetlenir.
  if (buf !== null) out.push({ text: buf, line: start });
  return out;
}

export interface ImageBuildDeps {
  docker: Dockerode;
  db: Db;
  /** Build log'larının kökü; `<artifactsDir>/image-builds/<buildId>.log`. */
  artifactsDir: string;
}

export interface ImageBuildInput {
  profileId: string;
  /**
   * Build bağlamı kökü — Dockerfile yolu buna göreli çözülür.
   *
   * ESKİDEN projenin git workspace'iydi; ARTIK DEĞİL. Analyst'in ürettiği
   * Dockerfile hiçbir zaman hedef repoya yazılmaz (bkz. `dockerfileAbsPath`,
   * `ExecSchema.dockerfile`) — motorun ürettiği bir yapı eseri yabancı bir
   * git reposuna karışmamalı. Bu alan bugün `<artifactsDir>/<projectId>/docker`
   * gibi sunucuya ait bir kök taşır.
   */
  workspaceRoot: string;
  /** `exec.dockerfile`: yukarıdaki köke göreli yol (bugün her zaman "Dockerfile"). */
  dockerfilePath: string;
  /** `exec.image`: build edilecek etiket. */
  imageRef: string;
  /** Çağıran önceden üretebilir: REST katmanı kimliği hemen döndürür. */
  buildId?: string;
  /**
   * Build'den hemen önce agent tabanı hazırlanamadıysa hatası. Build log'una
   * yazılır; taban imajı hiç yoksa build denenmeden bu hatayla düşülür.
   */
  baseError?: string;
}

/**
 * Profilin Dockerfile'ının artifactsDir içindeki SABİT konumu.
 *
 * Analyst'in ürettiği Dockerfile ASLA hedef workspace'e yazılmaz — motorun
 * ürettiği bir yapı eseri, bağlı olduğu YABANCI git reposunu kirletmemeli
 * (aynı kuralın ters yönü `docker/northwind/Dockerfile`ın ENGINE reposundan
 * silinmesine yol açmıştı: o da tek bir projeye özeldi, motora ait değildi).
 *
 * Projeye göre anahtarlanır (slug DEĞİL): id asla tekrar kullanılmaz, slug
 * bir proje silinip aynı adla yeniden oluşturulursa çakışabilir. Hem
 * `imageBuildPlan` hem `/build-image` ucu aynı yolu buradan üretir — iki ayrı
 * yerde aynı hesap tekrarlanırsa biri güncellenip diğeri unutulur.
 */
export function dockerfileAbsPath(artifactsDir: string, projectId: string): string {
  return join(resolve(artifactsDir), projectId, "docker", "Dockerfile");
}

/**
 * Build satırını AÇAR ve kimliğini döndürür — senkron, `analyze()` kalıbı.
 *
 * Kural 2 (önce niyet yazılır): satır `running` olarak doğar, çağıran kimliği
 * hemen istemciye verebilir. Sonucu `buildProfileImage` yazar.
 */
export function openImageBuild(db: Db, input: { profileId: string; imageRef: string; buildId?: string }): string {
  const id = input.buildId ?? newId();
  db.insert(schema.profileImageBuilds)
    .values({ id, profileId: input.profileId, status: "running", imageRef: input.imageRef })
    .run();
  return id;
}

/**
 * İmajı build eder ve satırı kapatır.
 *
 * FIRLATMAZ: arka planda (fire-and-forget) çağrılıyor, hatanın gideceği yer
 * `profile_image_builds.error` sütunudur. Çağıran yalnız log'lar.
 *
 * Docker daemon'ı paylaşılan `dockerApi` instance'ından gelir — burada YENİ
 * bir bağlantı açılmaz; app tek bir Docker istemcisi tutar.
 */
export async function buildProfileImage(deps: ImageBuildDeps, input: ImageBuildInput): Promise<void> {
  const buildId = input.buildId ?? openImageBuild(deps.db, input);
  const logPath = join(deps.artifactsDir, "image-builds", `${buildId}.log`);

  // Log satırları bellekte biriktirilip SONUNDA tek seferde yazılır: build
  // dakikalar sürer ama satır başına dosya açmak (yüzlerce adım) ölçülebilir
  // bir yük. Polling süren build'i DB durumundan, çıktıyı bitince görür.
  const lines: string[] = [];
  const append = (line: string): void => {
    // Kural 4: DB'ye ya da UI'a giden her metin maskelenir. `docker build`
    // çıktısı `--build-arg` değerlerini ve indirilen URL'leri yansıtabilir.
    lines.push(scrubSecrets(line));
  };

  const finish = async (status: "succeeded" | "failed", error: string | null): Promise<void> => {
    let logRef: string | null = null;
    try {
      await mkdir(dirname(logPath), { recursive: true });
      await writeFile(logPath, lines.join("\n"), "utf8");
      logRef = logPath;
    } catch {
      // Log yazılamazsa build sonucu YİNE DE kaydedilir: durumun kaybolması,
      // çıktının kaybolmasından pahalıdır (satır sonsuza dek "running" kalırdı).
    }
    deps.db
      .update(schema.profileImageBuilds)
      .set({ status, error, logRef })
      .where(eq(schema.profileImageBuilds.id, buildId))
      .run();
  };

  try {
    const workspaceRoot = resolve(input.workspaceRoot);
    const dockerfileAbs = resolve(workspaceRoot, input.dockerfilePath);

    // Profilden gelen yolun workspace dışına çıkmadığı ÖNCEDEN doğrulanır
    // (kural 3: değer üretici taraftan geliyor, sınır yeniden zorlanır).
    const rel = relative(workspaceRoot, dockerfileAbs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      await finish("failed", `Dockerfile workspace kökünün dışında: ${input.dockerfilePath}`);
      return;
    }

    /**
     * BUILD BAĞLAMI = Dockerfile'ın KENDİ DİZİNİ, workspace kökü DEĞİL.
     *
     * İki gerçek nedeni var:
     *
     *  1. `src: ["."]` bir glob değil, tar-fs'e verilen literal giriş listesi.
     *     Workspace kökünde `.dockerignore` varsa ve kuralı "."yı eleyecek
     *     biçimde eşleşiyorsa tar BOŞ çıkar ve build "Cannot locate specified
     *     Dockerfile" gibi kökeni belirsiz bir hatayla düşer.
     *  2. Mutlu yolda bile tüm workspace (`node_modules`, `.git` dâhil) her
     *     onayda tar+gzip edilirdi — gigabayt mertebesinde boşuna iş.
     *
     * Üretilen tarif kendi kendine yeterli: `FROM ahtapot/agent-base` + paket
     * kurulumları, workspace'ten `COPY` yok (bkz. agents/core/analyst.md).
     */
    const context = dirname(dockerfileAbs);
    const dockerfileName = basename(dockerfileAbs);

    append(`# ${input.imageRef} ← ${rel.split(sep).join("/")}`);

    if (input.baseError !== undefined) {
      const baseError = scrubSecrets(input.baseError);
      append(`# agent tabanı hazırlanamadı: ${baseError}`);
      // Taban hiç yoksa build'i denemenin anlamı yok: Docker yerel etiketi
      // bulamayınca `FROM ahtapot/agent-base`i Docker Hub'da arar ve build
      // "pull access denied for ahtapot/agent-base, repository does not
      // exist" ile düşer — asıl sebep (tabanın neden build edilemediği)
      // yalnız sunucu log'unda kalır, UI'daki hata yanıltıcı olur (YAŞANDI,
      // 2026-10-09). Taban VARSA (eski de olsa) build denenir: var olan taban
      // üstünde kurulan imaj hiç yoktan iyidir.
      const baseExists = await deps.docker
        .getImage(`${BRAND.slug}/agent-base:latest`)
        .inspect()
        .then(() => true, () => false);
      if (!baseExists) {
        await finish("failed", `agent tabanı (${BRAND.slug}/agent-base) yok ve build edilemedi: ${baseError}`);
        return;
      }
    }

    // Aynı etiketle yeniden build eski imajı silmez, `<none>` olarak bırakır;
    // her taban değişikliğinde proje başına ~1,7 GB birikiyordu. Kimlik
    // build'den ÖNCE alınır: sonra etiket yeni imajı gösterir.
    const previousId = await imageId(deps.docker, input.imageRef);

    const failure = await runDockerBuild(
      deps.docker,
      { context, src: [dockerfileName] },
      // Bağlam artık Dockerfile'ın dizini olduğu için ad yalın kalır; Docker
      // API yol ayracı olarak daima "/" bekler, burada ayraç zaten yok.
      //
      // `nocache`: taban imaj (`ahtapot/agent-base`) yerinde güncellendiğinde
      // Dockerfile metni DEĞİŞMEZ, bu yüzden Docker tüm katmanları cache'ten
      // alır ve üretilen profil imajı ESKİ tabanın içeriğini taşımaya devam
      // eder. Build "başarılı" der, log temiz görünür, içerik eskidir —
      // sessiz başarısızlık. YAŞANDI (2026-09-21): agent-base güncellendikten
      // sonra da profil imajı eski SDK'yı taşıdı ve iş, kökeni yanıltıcı bir
      // "native binary failed to launch / libc uyuşmazlığı" hatasıyla düştü.
      //
      // `pull` EKLENMEZ: `ahtapot/agent-base` bir registry yolu değil yerel
      // etikettir; `pull` Docker'ı onu Docker Hub'da aratır ve build
      // "pull access denied ... repository does not exist" ile kırılır
      // (ölçüldü, aynı gün). Tabanın tazeliği host'taki `docker pull` + `tag`
      // adımının sorumluluğunda (bkz. docker-compose.yml başlığı).
      //
      // Bedeli build süresi: profil imajları nadiren build ediliyor, buna
      // karşılık eski taban üstünde sessizce koşmanın bedeli bir günlük
      // teşhis oldu.
      { t: input.imageRef, dockerfile: dockerfileName, nocache: true },
      append,
    );


    if (failure) {
      await finish("failed", scrubSecrets(failure));
      return;
    }
    if (previousId && previousId !== (await imageId(deps.docker, input.imageRef))) {
      append(await removeImage(deps.docker, previousId));
    }
    await finish("succeeded", null);
  } catch (err) {
    await finish("failed", scrubSecrets(err instanceof Error ? err.message : String(err)));
  }
}

/** İmajın kimliği; yoksa `null`. */
export async function imageId(docker: Dockerode, ref: string): Promise<string | null> {
  return docker.getImage(ref).inspect().then((i) => i.Id, () => null);
}

/**
 * Artık kullanılmayan imajı siler; sonucu log satırı olarak döndürür.
 *
 * `force` YOK: Docker kullanımdaki (duran konteyner dâhil), başka etiketi
 * olan ya da çocuk imajı olan imajı reddeder. Reddedilen imaj kalır — yanlış
 * imajı silmektense bir kalıntı bırakmak ucuzdur. Silme hatası build'i
 * düşürmez.
 */
export async function removeImage(docker: Dockerode, ref: string): Promise<string> {
  try {
    await docker.getImage(ref).remove();
    return `# eski imaj silindi: ${ref}`;
  } catch (err) {
    return `# eski imaj silinemedi (${ref}): ${scrubSecrets(err instanceof Error ? err.message : String(err))}`;
  }
}

/**
 * `docker build`i koşturur ve bitmesini bekler; hata varsa mesajını, yoksa
 * `null` döndürür. Profil imajından ayrıldı: başka bir imaj (ör. agent
 * tabanı) aynı yoldan build edilebilsin — BuildKit akışının tuzakları
 * (aşağıda) iki yerde ayrı ayrı çözülmesin.
 */
export async function runDockerBuild(
  docker: Dockerode,
  context: { context: string; src: string[] },
  opts: Record<string, unknown>,
  append: (line: string) => void,
): Promise<string | null> {
  const stream = await docker.buildImage(context, opts);
return new Promise<string | null>((resolveProgress) => {
    // `docker.followProgress` — `docker.modem.followProgress` DEĞİL.
    //
    // BuildKit açık bir daemon'da (Docker Desktop'ta VARSAYILAN, ya da
    // `DOCKER_BUILDKIT=1`) `/build` ucu düz JSON değil base64 protobuf trace
    // satırları döndürür. Modem'in `processLine`ı bunu try/catch'siz
    // `JSON.parse` eder: satır malformed ise EventEmitter callback'inin
    // İÇİNDE senkron throw eder, hata `uncaughtException` olarak kaçar ve bu
    // promise ASLA çözülmez — satır sonsuza dek `running` kalır, retry de
    // sonsuza dek 409 döner. Dockerode'un kendi sarmalayıcısı (lib/buildkit.js)
    // aynı imzayı taşır, try/catch'lidir ve BuildKit satırlarını çözer.
    let settled = false;
    const settle = (reason: string | null): void => {
      if (settled) return;
      settled = true;
      resolveProgress(reason);
    };

    // Sarmalayıcı kendi `error` dinleyicisini ekliyor; yine de akışın
    // kendisi (soket kopması) için ikinci bir guard bırakılıyor — dinleyicisi
    // olmayan bir `error` olayı Node'da süreci düşürür.
    stream.on("error", (err: Error) => settle(err.message));

    (docker as unknown as FollowsProgress).followProgress(
      stream,
      (err: Error | null, output: BuildProgressLine[] | undefined) => {
        if (err) {
          settle(err.message);
          return;
        }
        // Hata satırı AKIŞTA taşınır ama `err` null kalabilir: build adımı
        // sıfırdan farklı bir kodla çıktığında olan tam budur.
        const failed = output?.find((o) => o.error ?? o.errorDetail?.message);
        settle(failed ? (failed.errorDetail?.message ?? failed.error ?? "build düştü") : null);
      },
      (event: BuildProgressLine) => {
        const text = event.stream ?? event.status ?? event.error ?? "";
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) append(line);
        }
      },
    );
  });
}

/**
 * Yarıda kalmış imaj build'lerini kapatır — sunucu açılışında çağrılır.
 *
 * `reconcileInterruptedAnalyses` ile aynı kalıp: build süreç içi bir
 * promise'te sürer, süreç ölürse satır "running"da kalır ve onu kimse
 * tamamlamaz. "Önce niyet yazılır" kuralının bedeli budur.
 */
export function reconcileInterruptedImageBuilds(db: Db): number {
  const stuck = db
    .select({ id: schema.profileImageBuilds.id })
    .from(schema.profileImageBuilds)
    .where(eq(schema.profileImageBuilds.status, "running"))
    .all();

  for (const s of stuck) {
    db.update(schema.profileImageBuilds)
      .set({ status: "failed", error: "sunucu yeniden başladı; imaj build'i yarıda kaldı" })
      .where(eq(schema.profileImageBuilds.id, s.id))
      .run();
  }
  return stuck.length;
}
