import { join } from "node:path";

import type { ProjectProfile } from "@ahtapot/shared";

import type { AgentTransport } from "../agents/transport.js";
import { ContainerTransport } from "../agents/transport.js";
import { ContainerExecutor, type CommandExecutor } from "../build/executor.js";
import { withRegistryAuth } from "../build/registryAuth.js";
import type { BridgeRegistry } from "../exec/bridge.js";
import type { ContainerManager } from "../exec/docker.js";

/**
 * Developer çalışma zamanı — agent + build komutları NEREDE koşar?
 *
 * Motor bunu bilmez; yalnız "bana bu iş için taşıma ve yürütücü ver" der.
 * Gerçek uygulama Docker'dır (konteyner + köprü + docker exec). Testler host
 * yürütücü ve sahte taşıma verir. `engine/` Docker'ı bilmez kuralı buradan.
 */
export interface DeveloperRuntime {
  acquire(input: {
    jobId: string;
    profile: ProjectProfile;
    /**
     * Kaynak workspace'in host yolu — konteynere SALT OKUNUR bağlanır.
     *
     * Worktree artık named volume'de yaşıyor, ama mirror'ın fetch kaynağı ve
     * gitignore'lu kopyalamanın kaynağı hâlâ kullanıcının checkout'u.
     */
    sourceRoot?: string;
    /** İş açma formunun ekleri — konteynere SALT OKUNUR bağlanır, varsa. */
    resourcesRoot?: string;
    /**
     * İşe bağlı emsal yolları (host) — her biri SALT OKUNUR bağlanır.
     * Konteyner içi yeri `jobReferenceMounts` belirler; prompt da aynı
     * fonksiyonu çağırır, iki taraf yolda anlaşmak zorunda.
     */
    referencePaths?: string[];
    /** Projenin kod haritası dizini (host) — SALT OKUNUR `/codemap`e bağlanır (karar §35). */
    codeMapRoot?: string;
  }): Promise<AcquiredRuntime>;

  /**
   * VAR OLAN konteynere bağlanır; yoksa `null`.
   *
   * `acquire` konteyner kurar ve köprü bekler (60 sn'ye kadar) — salt okuma
   * isteği için ağır ve yan etkili. UI'ın canlı diff ucu bunu kullanır:
   * konteyner ayaktaysa okur, değilse "hazır değil" der.
   */
  attach?(jobId: string, profile: ProjectProfile): Promise<AcquiredRuntime | null>;

  /**
   * İşin konteynerini ve volume'ünü kaldırır.
   *
   * Merge sonrası temizlikte çağrılır (`git.pr.cleanup.container`). Motor
   * Docker'ı bilmez; kaldırma da bu arayüzün arkasında kalır.
   */
  release?(jobId: string, opts?: { removeVolume?: boolean }): Promise<void>;
}

export interface AcquiredRuntime {
  transport: AgentTransport;
  executor: CommandExecutor;
  /** Yürütücünün gördüğü worktree yolu (konteynerde `/workspace/<repo>`). */
  workdir: string;
  /** Agent'ın gördüğü worktree yolu. Volume'de host karşılığı yok: konteyner yolu. */
  agentCwd: string;
  /** İş dizininin konteynerdeki kökü (`/workspace`) — worktree hazırlığı buraya yazar. */
  workdirRoot: string;
  /** Kaynak workspace'in konteynerdeki yeri (salt okunur), bağlıysa. */
  sourceMount?: string;
  /** İş açma formunun eklerinin konteynerdeki yeri (salt okunur), bağlıysa. */
  resourcesMount?: string;
  /** Kod haritasının konteynerdeki yeri, bağlıysa. */
  codeMapMount?: string;
}

/** Kod haritasının konteynerdeki sabit yeri. */
export const CODEMAP_MOUNT = "/codemap";

/**
 * Trail kod grafiklerinin konteynerdeki kökü (karar §44). Volume'de değil,
 * konteynerin kendi diskinde: worktree'ye girmez, iş bitince konteynerle gider.
 */
export const CODEGRAPH_ROOT = "/home/node/.cache/ahtapot-codegraph";

/** Kaynak workspace'in konteynerdeki sabit yeri. */
export const SOURCE_MOUNT = "/source";
/** Ek görsellerin/dosyaların konteynerdeki sabit yeri. */
export const RESOURCES_MOUNT = "/resources";
/** Referans depoların konteyner içi kökü — her biri `<kök>/<name>`e klonlanır. */
export const REFERENCE_ROOT = "/references";

/** `referenceRepos[].name` → konteyner içi klon yolu. */
export function referenceRepoPath(name: string): string {
  return `${REFERENCE_ROOT}/${name}`;
}

/** İşe bağlı emsal yollarının konteyner içi kökü. */
export const JOB_REFERENCE_ROOT = "/emsal";

/**
 * İşin emsal yolları → konteyner içi bağlama noktaları.
 *
 * Ad host yolunun son parçasıdır (`C:\src\contoso\src\Plugins` →
 * `/emsal/Plugins`): agent'a yolun NE olduğunu söyler. Aynı ad iki kez
 * gelirse sıra eki alır. Saf ve deterministik — runtime bağlarken, prompt
 * agent'a yol söylerken bunu çağırır.
 */
export function jobReferenceMounts(paths: readonly string[]): { hostPath: string; mount: string }[] {
  const used = new Set<string>();
  return paths.map((hostPath, i) => {
    const last = hostPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    const base = last.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || `emsal-${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);
    return { hostPath, mount: `${JOB_REFERENCE_ROOT}/${name}` };
  });
}

export class DockerRuntime implements DeveloperRuntime {
  constructor(
    private readonly deps: {
      containers: ContainerManager;
      bridges: BridgeRegistry;
      bridgeUrl: () => string;
      bridgeWaitMs?: number;
      /**
       * Konteyner kurulmadan önce imaj tazeliği (`exec/agentBase.ts`): agent
       * tabanı güncel mi, proje imajı güncel taban üstünde mi — değilse
       * build eder. Yoksa imaj olduğu gibi kullanılır (testler).
       */
      images?: { ensureForJob(jobId: string, profile: ProjectProfile): Promise<void> };
    },
  ) {}

  /**
   * Konteyneri kaldırır; istenirse volume'ü de.
   *
   * Volume worktree'yi taşıyor — `removeVolume` verilmedikçe DOKUNULMAZ:
   * merge sonrası bile ağacı post-mortem için saklamak isteyen olabilir.
   */
  async release(jobId: string, opts: { removeVolume?: boolean } = {}): Promise<void> {
    if (!(await this.deps.containers.available())) return;
    await this.deps.containers.remove(jobId);
    if (opts.removeVolume) await this.deps.containers.removeVolume(jobId);
  }

  /**
   * Ayakta olan konteynere bağlanır. Köprü beklenmez ve konteyner kurulmaz:
   * yalnız yürütücü gerekir (diff okumak gibi salt okuma işleri için).
   */
  async attach(jobId: string, profile: ProjectProfile): Promise<AcquiredRuntime | null> {
    if (!(await this.deps.containers.available())) return null;
    const container = await this.deps.containers.containerFor(jobId);
    if (!container) return null;
    const info = await container.inspect().catch(() => null);
    if (!info?.State.Running) return null;

    const workdirRoot = profile.exec.workdir;
    const repoName = profile.workspace.repos.find((r) => r.primary)?.name ?? "app";
    const session = this.deps.bridges.get(jobId);
    const worktree = `${workdirRoot}/worktrees/${jobId}/${repoName}`.replace(/\/+/g, "/");
    return {
      // Köprü yoksa taşıma da yok: bu yol yalnız yürütücü isteyen çağrılar
      // içindir, agent koşturmak `acquire`in işi.
      transport: session
        ? new ContainerTransport(session, { containerRoot: workdirRoot })
        : (null as unknown as AgentTransport),
      executor: withRegistryAuth(new ContainerExecutor(container), profile.exec.registries),
      workdir: worktree,
      agentCwd: worktree,
      workdirRoot,
    };
  }

  async acquire(input: Parameters<DeveloperRuntime["acquire"]>[0]): Promise<AcquiredRuntime> {
    const { profile, jobId } = input;
    if (!(await this.deps.containers.available())) {
      // Kök nedeni (`lastError`, örn. EACCES) mesaja gömüyoruz — eskiden
      // yalnız jenerik metin gidiyordu ve `docker.sock` GID uyuşmazlığı gibi
      // sorunlar hiçbir logda görünmüyordu (YAŞANDI, 2026-09-19).
      const detail = this.deps.containers.lastError;
      throw new Error(
        detail
          ? `Docker erişilemiyor; Developer konteyneri kurulamadı — ${detail}`
          : "Docker erişilemiyor; Developer konteyneri kurulamadı",
      );
    }
    const workdirRoot = profile.exec.workdir;
    const repoName = profile.workspace.repos.find((r) => r.primary)?.name ?? "app";

    // Köprü token'ı yalnız yeni konteynerde anlamlı; var olan konteyner eski
    // token'la bağlıysa `get` onu döndürür.
    let session = this.deps.bridges.get(jobId);
    if (!session) {
      // Token BELLEKTE tutuluyor; sunucu yeniden başlayınca kaybolur. Ama
      // konteyner ayakta kalır ve içindeki köprü ESKİ token'la bağlanmaya
      // çalışır: sunucu "köprü token'ı uyuşmadı" deyip reddeder, 30 sn'de bir
      // yeniden dener ve acquire 60 sn sonra düşer (yaşandı — developing_failed).
      // `ensure` idempotent olduğu için yeni token'ı var olan konteynere
      // veremez; o konteyner artık BAYATTIR, kaldırılıp yeniden kurulmalı.
      if (await this.deps.containers.containerFor(jobId)) {
        await this.deps.containers.remove(jobId);
      }
      // Yalnız YENİ konteyner kurulurken: ayakta olan konteynerin imajı
      // değişmez, yeniden build onu etkilemez. Sunucu güncellemesi zaten
      // yeniden başlatma demek; köprü oturumları düşer ve bu yoldan geçilir.
      await this.deps.images?.ensureForJob(jobId, profile);
      const token = this.deps.bridges.issueToken(jobId);
      // Volume açıkça yaratılır: Docker mount ederken de yaratırdı ama etiketsiz
      // kalırdı ve `reconcile()` yetim volume'ü bulamazdı. `workdir`+`image`
      // ayrıca sahipliği düzeltmek için geçiyor — Docker mount noktasını
      // root:root yaratıyor ve `node` oraya yazamıyor (bkz. `chownVolume`).
      const jobVolume = await this.deps.containers.ensureVolume(jobId, workdirRoot, profile.exec.image);
      await this.deps.containers.ensure({
        jobId,
        image: profile.exec.image,
        jobVolume,
        workdir: workdirRoot,
        ...(input.sourceRoot ? { sourceRoot: input.sourceRoot, sourceMount: SOURCE_MOUNT } : {}),
        ...(input.resourcesRoot ? { resourcesRoot: input.resourcesRoot, resourcesMount: RESOURCES_MOUNT } : {}),
        readOnlyBinds: [
          ...jobReferenceMounts(input.referencePaths ?? []).map((r) => ({ source: r.hostPath, target: r.mount })),
          ...(input.codeMapRoot ? [{ source: input.codeMapRoot, target: CODEMAP_MOUNT }] : []),
        ],
        resources: profile.exec.resources,
        caches: profile.exec.caches,
        env: profile.exec.env,
        bridgeUrl: this.deps.bridgeUrl(),
        bridgeToken: token,
      });
      session = await this.deps.bridges.waitFor(jobId, this.deps.bridgeWaitMs ?? 60_000);
    }

    const container = await this.deps.containers.containerFor(jobId);
    if (!container) throw new Error(`konteyner bulunamadı: iş ${jobId}`);

    // Worktree volume kökünün ALTINDA: `<root>/worktrees/<jobId>/<repo>`.
    // `WorktreeManager.worktreePath` ile AYNI düzen olmalı — eskiden jobDir
    // zaten `worktrees/<jobId>`e işaret ettiği için `<root>/<repo>` yetiyordu;
    // volume'de kök `/workspace` olunca aradaki iki segment düşüyordu ve
    // kurulum boş bir dizinde koşup "çıkış 127" veriyordu (yaşandı).
    const worktree = `${workdirRoot}/worktrees/${jobId}/${repoName}`.replace(/\/+/g, "/");
    return {
      transport: new ContainerTransport(session, { containerRoot: workdirRoot }),
      executor: withRegistryAuth(new ContainerExecutor(container), profile.exec.registries),
      workdir: worktree,
      // Volume'de host yolu yok: agent da yürütücü de aynı konteyner yolunu görür.
      agentCwd: worktree,
      workdirRoot,
      ...(input.sourceRoot ? { sourceMount: SOURCE_MOUNT } : {}),
      ...(input.resourcesRoot ? { resourcesMount: RESOURCES_MOUNT } : {}),
      // Konteyner harita açılmadan kurulduysa bind yoktur; bu alan yalnız
      // "istendi" der. Prompt'a girmeden önce INDEX konteynerde aranır.
      ...(input.codeMapRoot ? { codeMapMount: CODEMAP_MOUNT } : {}),
    };
  }
}
