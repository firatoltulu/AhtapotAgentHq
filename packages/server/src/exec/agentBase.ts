import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type Dockerode from "dockerode";
import { eq } from "drizzle-orm";

import { BRAND, DOCKER_LABEL, scrubSecrets, type ProjectProfile } from "@ahtapot/shared";

import { buildProfileImage, dockerfileAbsPath, openImageBuild, runDockerBuild } from "../analyst/imageBuild.js";
import { schema, type Db } from "../db/index.js";

/**
 * Agent tabanı (`ahtapot/agent-base`) ve ondan türeyen proje imajlarının
 * tazeliği.
 *
 * ESKİDEN taban ghcr.io'da ayrı bir paketti; deploy'da biri `docker pull` +
 * `docker tag` yapmak ve ardından her proje imajını elle yeniden build etmek
 * zorundaydı. YAŞANDI (2026-09-23): sunucu SDK 0.3.280'e çıktı, bu iki adım
 * atlandı, iş konteyneri eski CLI (2.1.270) ile koştu ve API yeni modeli
 * `400 ... version 2.1.280 or newer is required` diye reddetti. Sunucu imajı
 * zaten aynı lock dosyasıyla kuruluyordu — ikinci imaj, aynı commit'in elle
 * eşitlenmesi gereken bir kopyasıydı.
 *
 * Şimdi taban, sunucunun KENDİ dosyalarından (köprü dist'i, lock, Dockerfile)
 * build edilir. İçeriğin parmak izi imaja etiket olarak yazılır; `FROM` ile
 * türeyen proje imajı etiketi miras alır. İş konteyneri kurulmadan önce proje
 * imajının etiketi güncel parmak iziyle karşılaştırılır, uyuşmazsa profilin
 * kendi tarifiyle yeniden build edilir (kullanıcı kararı: otomatik).
 *
 * Sunucu konteynerde koşarken de çalışır: build bağlamı Docker soketi
 * üzerinden tar olarak daemon'a gider, dosyaların host'ta olması gerekmez.
 */

export const AGENT_BASE_IMAGE = `${BRAND.slug}/agent-base`;
const AGENT_BASE_DOCKERFILE = "docker/agent/Dockerfile";

/**
 * Build bağlamına giren yollar — `docker/agent/Dockerfile`ın COPY ettikleri.
 * Parmak izi de YALNIZ bunlardan hesaplanır: tabanın içeriğini değiştirmeyen
 * bir sunucu değişikliği proje imajlarını boşuna yeniden build ettirmesin.
 */
const CONTEXT_ENTRIES = [
  AGENT_BASE_DOCKERFILE,
  "package.json",
  "package-lock.json",
  "packages/shared/package.json",
  "packages/shared/dist",
  "packages/bridge/package.json",
  "packages/bridge/dist",
];

/** Kök `.dockerignore` bunları bağlama almıyor; parmak izi de saymasın. */
const IGNORED = /(\.tsbuildinfo|\.test\.[^/]*)$/;

/**
 * Repo kökü (sunucu imajında `/opt/ahtapot`). `agents/prompts.ts` ile aynı
 * hesap: `packages/server/dist/exec/` → dört üst dizin.
 */
export function agentBaseContextRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "..");
}

async function listFiles(root: string, entry: string): Promise<string[]> {
  const abs = join(root, entry);
  if (!(await stat(abs)).isDirectory()) return IGNORED.test(entry) ? [] : [entry];
  const out: string[] = [];
  for (const name of (await readdir(abs)).sort()) {
    out.push(...(await listFiles(root, join(entry, name))));
  }
  return out;
}

/** Bağlamın içerik parmak izi — dosya yolu + içerik, sıralı. */
export async function agentBaseFingerprint(root: string): Promise<string> {
  const missing = CONTEXT_ENTRIES.filter((e) => !existsSync(join(root, e)));
  if (missing.length > 0) {
    // Geliştirmede köprü derlenmemiş olabilir; sunucu imajında olmamalı.
    throw new Error(`agent tabanının build bağlamı eksik (${root}): ${missing.join(", ")} — \`npm run build\` koşun`);
  }
  const hash = createHash("sha256");
  for (const entry of CONTEXT_ENTRIES) {
    for (const file of await listFiles(root, entry)) {
      hash.update(file.split(sep).join("/"));
      hash.update("\0");
      hash.update(await readFile(join(root, file)));
      hash.update("\0");
    }
  }
  return hash.digest("hex").slice(0, 16);
}

function isBaseImage(ref: string): boolean {
  return ref === AGENT_BASE_IMAGE || ref.startsWith(`${AGENT_BASE_IMAGE}:`);
}

export interface AgentImagesDeps {
  docker: Dockerode;
  db: Db;
  artifactsDir: string;
  contextRoot?: string;
  log: (obj: Record<string, unknown>, msg: string) => void;
}

export class AgentImages {
  /** Süren/biten taban denetimi. Başarısızsa sıfırlanır: sonraki çağrı yeniden dener. */
  private base: Promise<string> | null = null;
  /** Aynı proje imajı için iki eşzamanlı iş iki build başlatmasın. */
  private readonly projectBuilds = new Map<string, Promise<void>>();

  constructor(private readonly deps: AgentImagesDeps) {}

  /**
   * `ahtapot/agent-base:latest` güncel parmak izini taşıyor mu; taşımıyorsa
   * build eder. Parmak izini döndürür. Idempotent; açılışta ve her iş
   * konteynerinden önce çağrılır, build yalnız içerik değişince koşar.
   */
  ensureBase(): Promise<string> {
    this.base ??= this.buildBaseIfStale().catch((err: unknown) => {
      this.base = null;
      throw err;
    });
    return this.base;
  }

  private async buildBaseIfStale(): Promise<string> {
    const root = this.deps.contextRoot ?? agentBaseContextRoot();
    const fp = await agentBaseFingerprint(root);
    if ((await this.labelOf(`${AGENT_BASE_IMAGE}:latest`)) === fp) {
      await this.pruneBaseTags(fp);
      return fp;
    }

    this.deps.log({ fingerprint: fp }, "agent tabanı eski ya da yok — build ediliyor");
    const lines: string[] = [];
    const failure = await runDockerBuild(
      this.deps.docker,
      { context: root, src: CONTEXT_ENTRIES },
      // `nocache` YOK: katmanlar içerikten anahtarlanıyor (COPY), aynı lock
      // ile `npm ci` katmanını yeniden koşmanın kazancı yok.
      { t: `${AGENT_BASE_IMAGE}:${fp}`, dockerfile: AGENT_BASE_DOCKERFILE, labels: { [DOCKER_LABEL.base]: fp } },
      (line) => lines.push(scrubSecrets(line)),
    );
    const logPath = join(this.deps.artifactsDir, "image-builds", `agent-base-${fp}.log`);
    await mkdir(dirname(logPath), { recursive: true }).then(() => writeFile(logPath, lines.join("\n"), "utf8")).catch(() => undefined);
    if (failure) throw new Error(`agent tabanı build edilemedi: ${scrubSecrets(failure)} (log: ${logPath})`);

    // Proje Dockerfile'ları `FROM ahtapot/agent-base` (= `:latest`) diyor;
    // sürümlü etiket geri dönüş ve teşhis için kalır.
    await this.deps.docker.getImage(`${AGENT_BASE_IMAGE}:${fp}`).tag({ repo: AGENT_BASE_IMAGE, tag: "latest" });
    this.deps.log({ fingerprint: fp }, "agent tabanı hazır");
    await this.pruneBaseTags(fp);
    return fp;
  }

  /**
   * Eski sürümlü taban etiketlerini siler; güncel ve bir önceki kalır.
   *
   * Her taban değişikliği yeni bir `:<parmak izi>` ekliyor ve hiçbiri
   * silinmiyordu: 17 etiket, her biri ~1,7 GB (ölçüldü, 2026-10-15). Bir
   * önceki geri dönüş ve teşhis için tutulur. Etiket silmek imajı ancak
   * başka etiketi ve çocuğu yoksa siler; eski taban üstündeki proje imajı
   * duruyorsa katmanlar onunla birlikte gider (bkz. `buildProfileImage`).
   * Hata açılışı düşürmez.
   */
  private async pruneBaseTags(current: string): Promise<void> {
    try {
      const images = await this.deps.docker.listImages({ filters: { reference: [AGENT_BASE_IMAGE] } });
      const old = images
        .sort((a, b) => b.Created - a.Created)
        .flatMap((img) => img.RepoTags ?? [])
        .filter((t) => isBaseImage(t) && t !== `${AGENT_BASE_IMAGE}:latest` && t !== `${AGENT_BASE_IMAGE}:${current}`)
        .slice(1);
      for (const tag of old) {
        await this.deps.docker.getImage(tag).remove().then(
          () => this.deps.log({ tag }, "eski agent tabanı etiketi silindi"),
          (err: unknown) => this.deps.log({ tag, err: err instanceof Error ? err.message : String(err) }, "eski agent tabanı etiketi silinemedi"),
        );
      }
    } catch (err) {
      this.deps.log({ err: err instanceof Error ? err.message : String(err) }, "agent tabanı etiketleri taranamadı");
    }
  }

  /**
   * İş konteyneri kurulmadan önce: taban güncel mi, proje imajı güncel taban
   * üstünde mi? Değilse profilin kendi tarifiyle yeniden build eder. Build
   * `profile_image_builds`a yazılır — UI'daki imaj paneli bunu da gösterir.
   */
  async ensureForJob(jobId: string, profile: ProjectProfile): Promise<void> {
    const fp = await this.ensureBase();
    const image = profile.exec.image;
    if (isBaseImage(image)) return;
    const label = await this.labelOf(image);
    if (label === fp) return;
    // Var olan ama etiketsiz imaj iki şey olabilir: etiketten önce tabanın
    // üstüne kurulmuş bir proje imajı ya da profilde elle verilmiş dış imaj
    // (örn. `mcr.microsoft.com/dotnet/sdk:10.0`). İkincisi yeniden build
    // edilirse yerel etiket proje tarifinin çıktısıyla ezilir, tarif yoksa iş
    // düşer — yalnız tarif tabandan türüyorsa yeniden build edilir.
    if (label === null && !(await this.recipeUsesBase(jobId, profile))) return;

    let pending = this.projectBuilds.get(image);
    if (!pending) {
      pending = this.rebuildProject(jobId, profile, fp).finally(() => this.projectBuilds.delete(image));
      this.projectBuilds.set(image, pending);
    }
    await pending;
  }

  private async rebuildProject(jobId: string, profile: ProjectProfile, fp: string): Promise<void> {
    const image = profile.exec.image;
    const row = this.deps.db
      .select({ projectId: schema.jobs.projectId, profileId: schema.jobs.profileId, activeProfileId: schema.projects.activeProfileId })
      .from(schema.jobs)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.jobs.projectId))
      .where(eq(schema.jobs.id, jobId))
      .all()[0];
    const profileId = row?.profileId ?? row?.activeProfileId ?? null;
    if (!row || !profileId) throw new Error(`proje imajı eski tabanla kurulmuş, iş için profil bulunamadı: ${jobId}`);

    const dockerfile = dockerfileAbsPath(this.deps.artifactsDir, row.projectId);
    if (!existsSync(dockerfile)) {
      throw new Error(
        `proje imajı (${image}) eski agent tabanıyla kurulmuş ve yeniden build edilemiyor: Dockerfile yok — projeyi yeniden analiz edin`,
      );
    }

    this.deps.log({ jobId, image, fingerprint: fp }, "proje imajı eski taban üstünde — yeniden build ediliyor");
    const buildId = openImageBuild(this.deps.db, { profileId, imageRef: image });
    await buildProfileImage(
      { docker: this.deps.docker, db: this.deps.db, artifactsDir: this.deps.artifactsDir },
      { profileId, buildId, workspaceRoot: dirname(dockerfile), dockerfilePath: profile.exec.dockerfile ?? "Dockerfile", imageRef: image },
    );
    const result = this.deps.db
      .select({ status: schema.profileImageBuilds.status, error: schema.profileImageBuilds.error })
      .from(schema.profileImageBuilds)
      .where(eq(schema.profileImageBuilds.id, buildId))
      .all()[0];
    if (result?.status !== "succeeded") {
      throw new Error(`proje imajı yeni tabanla build edilemedi (${image}): ${result?.error ?? "bilinmeyen hata"}`);
    }
  }

  /**
   * İmajın taban etiketi: imaj yoksa `undefined`, var ama etiketsizse `null`.
   * İkisi ayrı tutulur — yok olan imaj her durumda build edilmeli, etiketsiz
   * olan ise dış imaj olabilir (bkz. `ensureForJob`).
   */
  private async labelOf(image: string): Promise<string | null | undefined> {
    let info: Awaited<ReturnType<Dockerode.Image["inspect"]>>;
    try {
      info = await this.deps.docker.getImage(image).inspect();
    } catch {
      return undefined;
    }
    return info.Config?.Labels?.[DOCKER_LABEL.base] ?? null;
  }

  /** Projenin eser Dockerfile'ı `FROM ahtapot/agent-base` ile mi başlıyor? */
  private async recipeUsesBase(jobId: string, profile: ProjectProfile): Promise<boolean> {
    const row = this.deps.db
      .select({ projectId: schema.jobs.projectId })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .all()[0];
    if (!row) return false;
    const path = join(dirname(dockerfileAbsPath(this.deps.artifactsDir, row.projectId)), profile.exec.dockerfile ?? "Dockerfile");
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) return false;
    // İlk anlamlı satır; `validateDockerfileContent` ile aynı ölçüt.
    const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    return first !== undefined && new RegExp(`^FROM\\s+${AGENT_BASE_IMAGE.replace("/", "\\/")}(:[\\w.-]+)?(\\s+AS\\s+\\w+)?$`, "i").test(first);
  }
}
