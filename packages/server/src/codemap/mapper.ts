import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { CodeMapModuleSchema, scrubSecrets, type CodeMap, type CodeMapLessons, type CodeMapModule, type CodeMapStatus, type ProjectProfile } from "@ahtapot/shared";

import { extractBlock } from "../analyst/analyst.js";
import type { AgentRunner } from "../agents/runner.js";
import { loadRolePrompt } from "../agents/prompts.js";
import { shellQuote, type CommandExecutor } from "../build/executor.js";
import { isoNow } from "../db/index.js";
import { codeMapDir, inModule, readCodeMap, writeCodeMap } from "./store.js";

/**
 * Kod haritasını üretir ve taze tutar.
 *
 * İki giriş:
 *  • `generate` — tam üretim (insan ister ya da harita hiç yoksa ilk iş).
 *  • `refresh` — kaynak senkronundan sonra: değişen dosyaları künyelere
 *    eşler, bayatları işaretler ve ARKA PLANDA yeniden ürettirir. İş beklemez.
 *    Merge sonrası çağrıda işin dersleri de gelir: dokunduğu
 *    künyeler aynı koşuda yeniden üretilir, haritacı dersi `pitfalls`a işler.
 *
 * Agent HOST'ta, kaynak checkout üzerinde ve salt okunur koşar (Analyst
 * gibi): harita iş konteynerine bağlı değil, projeye ait.
 */

type Repo = ProjectProfile["workspace"]["repos"][number];
type Scope = { kind: "full" } | { kind: "partial"; modules: CodeMapModule[]; unmapped: string[]; lessons: LessonTarget[] };
/** Kuyruktaki ders; `failures` içinde düştüğü koşu sayısı. */
interface QueuedLessons { lessons: CodeMapLessons; failures: number }
/** Ders + dokunduğu künyeler. */
interface LessonTarget extends QueuedLessons { modules: string[] }

/**
 * Bir dersin binebileceği en fazla düşen koşu. Yeniden deneme kendiliğinden
 * koşu açmaz, sonraki tazelemeyi bekler; tavan, haritacıyı her seferinde
 * düşüren bir dersin her işte yeniden ödenmesini önler.
 */
const MAX_LESSON_FAILURES = 3;

export interface CodeMapperDeps {
  runner: AgentRunner;
  /** Host yürütücü — kaynak checkout'ta `git rev-parse`/`git diff`. */
  exec: CommandExecutor;
  artifactsDir: string;
  log: (level: "info" | "warn", obj: Record<string, unknown>, msg: string) => void;
}

export class CodeMapper {
  /** Koşan agent üretimi — proje başına en fazla bir tane. */
  private readonly running = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, string>();
  /**
   * Haritaya yazan her şey (tazelik işareti, üretimin birleştirmesi) proje
   * başına sıraya girer: üretim dakikalar sürer, o arada bir iş açılıp
   * bayat işareti yazarsa biri ötekinin yazdığını ezerdi.
   */
  private readonly chains = new Map<string, Promise<unknown>>();
  /**
   * Koşu sürerken gelen dersler. Ayrı koşu açılmaz: koşu bitince bir
   * tazeleme daha tetiklenir, dersler onunla gider. Bellekte durur; sunucu
   * yeniden başlarsa düşer. Ders kaybı işi bozmaz, haritayı zenginleştirmez.
   */
  private readonly pending = new Map<string, { profile: ProjectProfile; items: QueuedLessons[] }>();

  constructor(private readonly deps: CodeMapperDeps) {}

  dir(projectId: string): string {
    return codeMapDir(this.deps.artifactsDir, projectId);
  }

  /**
   * Konteynere bağlanacak dizin; harita kapalıysa `null`. Dizin yoksa
   * yaratılır: konteyner kurulurken bağlanmalı ki ilk üretim iş sürerken
   * bitse bile içeriği o konteynerde görünsün.
   */
  mountRoot(projectId: string, profile: ProjectProfile): string | null {
    if (!profile.agents.codeMap.enabled) return null;
    const dir = this.dir(projectId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Haritanın kendisi (UI'da okumak için). Yoksa ya da bozuksa `null`. */
  map(projectId: string): CodeMap | null {
    return readCodeMap(this.dir(projectId));
  }

  status(projectId: string, profile: ProjectProfile | null): CodeMapStatus {
    const map = readCodeMap(this.dir(projectId));
    return {
      enabled: profile?.agents.codeMap.enabled ?? false,
      running: this.running.has(projectId),
      lastError: this.errors.get(projectId) ?? null,
      generatedAt: map?.generatedAt ?? null,
      commits: map?.commits ?? {},
      modules: map?.modules.length ?? 0,
      stale: map?.modules.filter((m) => m.stale.length > 0).map((m) => m.id) ?? [],
      unmapped: map?.unmapped.length ?? 0,
    };
  }

  /** Tam üretimi arka planda başlatır. Zaten koşuyorsa `false`. */
  generate(projectId: string, profile: ProjectProfile): boolean {
    return this.start(projectId, profile, { kind: "full" });
  }

  /**
   * Tazelik denetimi. Fırlatmaz — haritanın bayatlığı işi durdurmaz.
   * Harita yoksa tam üretimi başlatır.
   */
  async refresh(projectId: string, profile: ProjectProfile, lessons?: CodeMapLessons): Promise<{ stale: string[]; learning: string[]; started: boolean }> {
    if (!profile.agents.codeMap.enabled) return { stale: [], learning: [], started: false };
    if (lessons && profile.agents.codeMap.learn && lessons.notes.length > 0) {
      this.enqueue(projectId, profile, [{ lessons, failures: 0 }]);
    }
    try {
      const dir = this.dir(projectId);
      const marked = await this.serialize(projectId, async () => {
        const map = readCodeMap(dir);
        if (!map) return null;
        const next = await this.markStale(map, profile);
        writeCodeMap(dir, next, profile.name);
        return next;
      });
      // Harita yoksa dersler bekler: tam üretim bitince tetiklenen tazelemeyle gider.
      if (!marked) return { stale: [], learning: [], started: this.generate(projectId, profile) };
      const stale = marked.modules.filter((m) => m.stale.length > 0).map((m) => m.id);
      // Koşu sürüyorsa dersler kuyrukta kalır; koşunun bitişi yeniden çağırır.
      if (this.running.has(projectId)) return { stale, learning: [], started: false };
      const targets = this.drainLessons(projectId, marked);
      const learning = [...new Set(targets.flatMap((t) => t.modules))];
      const ids = new Set([...stale, ...learning]);
      if (ids.size === 0 && marked.unmapped.length === 0) return { stale, learning, started: false };
      const started = this.start(projectId, profile, {
        kind: "partial",
        modules: marked.modules.filter((m) => ids.has(m.id)),
        unmapped: marked.unmapped,
        lessons: targets,
      });
      if (!started) this.enqueue(projectId, profile, targets.map(({ lessons, failures }) => ({ lessons, failures })));
      return { stale, learning: started ? learning : [], started };
    } catch (err) {
      this.deps.log("warn", { projectId, err: scrubSecrets(String(err)) }, "kod haritası tazelenemedi");
      return { stale: [], learning: [], started: false };
    }
  }

  /**
   * Bekleyen dersleri künyelere eşler ve kuyruktan alır. Dokunduğu dosyalar
   * hiçbir künyeye düşmeyen ders atılır: not künyeye bağlı yaşar, bağlanacak
   * künye yoksa yeri de yoktur.
   */
  private drainLessons(projectId: string, map: CodeMap): LessonTarget[] {
    const queued = this.pending.get(projectId);
    if (!queued) return [];
    this.pending.delete(projectId);
    const out: LessonTarget[] = [];
    for (const { lessons, failures } of queued.items) {
      const modules = new Set<string>();
      for (const file of lessons.files) {
        const at = locate(file, queued.profile.workspace.repos);
        if (!at) continue;
        for (const m of map.modules) if (m.repo === at.repo && inModule(m, at.path)) modules.add(m.id);
      }
      if (modules.size === 0) {
        this.deps.log("info", { projectId, jobId: lessons.jobId }, "kod haritası: işin dersi hiçbir künyeye düşmedi, atıldı");
        continue;
      }
      out.push({ lessons, failures, modules: [...modules] });
    }
    return out;
  }

  private enqueue(projectId: string, profile: ProjectProfile, items: QueuedLessons[]): void {
    if (items.length === 0) return;
    const queued = this.pending.get(projectId)?.items ?? [];
    this.pending.set(projectId, { profile, items: [...queued, ...items] });
  }

  private start(projectId: string, profile: ProjectProfile, scope: Scope): boolean {
    if (this.running.has(projectId)) return false;
    this.errors.delete(projectId);
    let ok = false;
    const p = this.produce(projectId, profile, scope)
      .then(() => { ok = true; })
      .catch((err: unknown) => {
        const msg = scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 1000);
        this.errors.set(projectId, msg);
        this.deps.log("warn", { projectId, scope: scope.kind, err: msg }, "kod haritası üretilemedi");
        // Dersler koşuya binmişti ama künyeye girmedi: kuyruğa geri, sonraki
        // tazelemede yeniden denenir. Tavanı aşan atılır.
        if (scope.kind === "partial") {
          const retry = scope.lessons.map((t) => ({ lessons: t.lessons, failures: t.failures + 1 }));
          const dropped = retry.filter((q) => q.failures >= MAX_LESSON_FAILURES);
          for (const q of dropped) {
            this.deps.log("warn", { projectId, jobId: q.lessons.jobId, failures: q.failures }, "kod haritası: işin dersi tekrar tekrar işlenemedi, atıldı");
          }
          this.enqueue(projectId, profile, retry.filter((q) => q.failures < MAX_LESSON_FAILURES));
        }
      })
      .finally(() => {
        this.running.delete(projectId);
        // Koşu sürerken gelen dersler bu koşuya binemedi; şimdi gitsinler.
        // Yalnız başarıda: düşen tam üretimden sonra tazeleme haritayı yok
        // görür, tam üretimi yeniden açar ve aynı hata sonsuz döngü olurdu.
        // Düşen koşunun geri kuyruğa aldığı dersler de sonraki işi bekler.
        const queued = this.pending.get(projectId);
        if (queued && ok) void this.refresh(projectId, queued.profile);
      });
    this.running.set(projectId, p);
    return true;
  }

  /**
   * Her künyenin `sha`sından bugünkü HEAD'e değişen dosyaları künyeye eşler.
   *
   * Değişiklik modülün dizinine düştüyse künye bayat (`stale` = o dosyalar);
   * düşmediyse künye hâlâ doğrudur ve `sha`sı HEAD'e ilerler. Bayat liste her
   * seferinde künyenin KENDİ `sha`sından hesaplanır, birikmez.
   */
  private async markStale(map: CodeMap, profile: ProjectProfile): Promise<CodeMap> {
    const heads = await this.heads(profile);
    const modules = map.modules.map((m) => ({ ...m }));
    const unmapped = new Set(map.unmapped);
    const commits = { ...map.commits };

    for (const repo of profile.workspace.repos) {
      const head = heads[repo.name];
      if (!head) continue;
      const dir = repoDir(profile.workspace.root, repo);
      const diffs = new Map<string, string[] | null>();
      const diff = async (sha: string) => {
        if (!diffs.has(sha)) diffs.set(sha, await this.changedFiles(dir, sha, head));
        return diffs.get(sha)!;
      };

      const mine = modules.filter((m) => m.repo === repo.name);
      for (const m of mine) {
        if (m.sha === head) continue;
        const files = m.sha ? await diff(m.sha) : null;
        if (files === null) {
          // Commit kaynakta yok (rebase, force-push) ya da hiç kaydedilmemiş:
          // neyin değiştiği bilinemez, künyenin tamamı şüpheli.
          m.stale = ["(künyenin commit'i bulunamadı — tümünü kodda doğrula)"];
          continue;
        }
        m.stale = files.filter((f) => inModule(m, f));
        if (m.stale.length === 0) m.sha = head;
      }

      const since = commits[repo.name];
      if (since && since !== head) {
        for (const f of (await diff(since)) ?? []) {
          if (!mine.some((m) => inModule(m, f))) unmapped.add(`${repo.name}/${f}`);
        }
      }
      commits[repo.name] = head;
    }
    return { ...map, modules, commits, unmapped: [...unmapped].sort(), generatedAt: isoNow() };
  }

  private async produce(projectId: string, profile: ProjectProfile, scope: Scope): Promise<void> {
    const cfg = profile.agents.codeMap;
    // HEAD agent okumaya BAŞLAMADAN alınır: koşu sürerken kaynak ilerlerse
    // künyeler eski commit'e damgalanır ve sonraki tazelik farkı yakalar.
    const heads = await this.heads(profile);
    const existing = readCodeMap(this.dir(projectId));
    const run = await this.deps.runner.run({
      jobId: null,
      role: "cartographer",
      prompt: renderPrompt(profile, scope, existing),
      model: scope.kind === "full" ? cfg.model : cfg.refreshModel,
      effort: "medium",
      maxTurns: scope.kind === "full" ? 200 : 60,
      maxBudgetUsd: cfg.maxBudgetUsd,
      cwd: profile.workspace.root,
      disallowedTools: ["Write", "Edit", "NotebookEdit", "MultiEdit"],
      systemPrompt: loadRolePrompt("cartographer"),
    });
    if (run.subtype === "error" || run.subtype === "quota") {
      throw new Error(`haritacı koşusu bitmedi (${run.subtype})${run.errorMessage ? `: ${run.errorMessage}` : ""}`);
    }
    const { modules, dropped } = synthesize(extractBlock(run.text, "CODEMAP_JSON"), profile);
    if (modules.length === 0) {
      throw new Error(`CODEMAP_JSON bloğu yok ya da geçerli modül içermiyor${dropped.length ? ` (${dropped.slice(0, 3).join(" · ")})` : ""}`);
    }
    if (dropped.length) this.deps.log("warn", { projectId, dropped: dropped.slice(0, 10) }, "kod haritası: geçersiz modüller atıldı");

    const now = isoNow();
    const stamped = modules.map((m) => ({ ...m, sha: heads[m.repo] ?? "", stale: [], updatedAt: now }));

    await this.serialize(projectId, async () => {
      // Birleştirme GÜNCEL harita üzerinde: koşu sürerken tazelik yazmış olabilir.
      const current = readCodeMap(this.dir(projectId));
      let merged: CodeMapModule[];
      let unmapped: string[];
      if (scope.kind === "full" || !current) {
        merged = stamped;
        unmapped = [];
      } else {
        const byId = new Map(current.modules.map((m) => [m.id, m]));
        for (const m of stamped) byId.set(m.id, m);
        merged = [...byId.values()];
        // Agent'a verilen haritasız dosyalar işlendi; koşu sırasında yenileri
        // geldiyse kalır.
        const handed = new Set(scope.unmapped);
        unmapped = current.unmapped.filter((f) => !handed.has(f));
      }
      const ids = new Set(merged.map((m) => m.id));
      for (const m of merged) m.dependsOn = m.dependsOn.filter((d) => ids.has(d) && d !== m.id);
      const map: CodeMap = {
        version: 1,
        projectId,
        generatedAt: now,
        commits: { ...(current?.commits ?? {}), ...heads },
        modules: merged.sort((a, b) => a.repo.localeCompare(b.repo) || a.id.localeCompare(b.id)),
        unmapped,
      };
      writeCodeMap(this.dir(projectId), map, profile.name);
    });
    this.deps.log("info", { projectId, scope: scope.kind, modules: stamped.length, costMicroUsd: run.costMicroUsd }, "kod haritası güncellendi");
  }

  private async heads(profile: ProjectProfile): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const repo of profile.workspace.repos) {
      const r = await this.git(repoDir(profile.workspace.root, repo), "rev-parse HEAD");
      if (r.code === 0 && /^[0-9a-f]{40,64}$/.test(r.out.trim())) out[repo.name] = r.out.trim();
    }
    return out;
  }

  /** `null`: `sha` bu repoda yok. */
  private async changedFiles(dir: string, sha: string, head: string): Promise<string[] | null> {
    const r = await this.git(dir, `diff --name-only ${shellQuote(sha)} ${shellQuote(head)}`);
    if (r.code !== 0) return null;
    return r.out.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  private async git(cwd: string, args: string): Promise<{ code: number | null; out: string }> {
    const lines: string[] = [];
    const res = await this.deps.exec.run({
      command: `git ${args}`,
      cwd,
      env: {},
      timeoutMs: 120_000,
      onLine: (s, l) => { if (s === "stdout") lines.push(l); },
    });
    return { code: res.exitCode, out: lines.join("\n") };
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }
}

/**
 * Agent çıktısını modüllere çevirir (kural 3, orta katman).
 *
 * Tek bozuk modül haritanın tamamını düşürmesin: modül modül doğrulanır,
 * bozuk olan nedeniyle atılır. `id` agent'ın sık bozduğu alan (büyük harf,
 * boşluk) — anlam değişmeden düzeltilir. Profilde olmayan repo atılır.
 */
export function synthesize(raw: unknown, profile: ProjectProfile): { modules: CodeMapModule[]; dropped: string[] } {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? (raw as Record<string, unknown>)["modules"] : null);
  if (!Array.isArray(list)) return { modules: [], dropped: [] };
  const repos = new Set(profile.workspace.repos.map((r) => r.name));
  const modules: CodeMapModule[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = { ...(item as Record<string, unknown>) };
    if (typeof o["id"] === "string") {
      o["id"] = o["id"].toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    }
    if (typeof o["paths"] === "string") o["paths"] = [o["paths"]];
    // Ders eklenince tavan aşılabiliyor; tek fazla tuzak künyenin tamamını düşürmesin.
    if (Array.isArray(o["pitfalls"])) o["pitfalls"] = o["pitfalls"].slice(0, 10);
    const parsed = CodeMapModuleSchema.safeParse(o);
    if (!parsed.success) {
      dropped.push(`${String(o["id"] ?? "?")}: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      continue;
    }
    if (!repos.has(parsed.data.repo)) {
      dropped.push(`${parsed.data.id}: bilinmeyen repo ${parsed.data.repo}`);
      continue;
    }
    if (seen.has(parsed.data.id)) {
      dropped.push(`${parsed.data.id}: tekrar eden id`);
      continue;
    }
    seen.add(parsed.data.id);
    modules.push(parsed.data);
  }
  return { modules, dropped };
}

function renderPrompt(profile: ProjectProfile, scope: Scope, existing: CodeMap | null): string {
  const lines: string[] = [];
  lines.push(`# Proje: ${profile.name}`);
  lines.push("Repolar (çalışma dizinine göreli):");
  for (const r of profile.workspace.repos) lines.push(`- ${r.name}: ${r.path}${r.primary ? " · PRIMARY" : ""}`);
  if (profile.agents.oversizedFiles.length) {
    lines.push(`Ham OKUMA (yalnız hedefli grep/başlık): ${profile.agents.oversizedFiles.map((f) => f.path).join(", ")}`);
  }
  if (profile.agents.docLayers.length) {
    lines.push(`Katmanlı dokümanlar: ${profile.agents.docLayers.map((d) => `${d.dir} (${d.purpose})`).join(", ")} — tuzak bilgisi için kaynak olabilir.`);
  }
  const secret = [...profile.security.sensitiveFiles, ...profile.security.neverCopy];
  if (secret.length) lines.push(`OKUMA (sır taşır): ${secret.join(", ")}`);

  if (scope.kind === "full") {
    lines.push("\n# Görev: tam harita");
    lines.push("Tüm repoları modüllere böl ve her modülün künyesini çıkar. Sonunda tam bir CODEMAP_JSON bloğu üret.");
  } else {
    lines.push("\n# Görev: kısmi tazeleme");
    if (scope.modules.length) {
      lines.push("Aşağıdaki künyeler yeniden üretilecek. `stale` doluysa o dosyalar künye üretildikten sonra değişti; boşsa künye ders için açıldı.");
      lines.push("Yalnız bu modülleri yeniden üret (AYNI `id`). Değişen dosyalara bak; künyenin geri kalanını doğrula.");
      lines.push("```json");
      lines.push(JSON.stringify(scope.modules.map(({ sha: _s, updatedAt: _u, ...m }) => m), null, 1));
      lines.push("```");
    }
    if (scope.unmapped.length) {
      lines.push("Hiçbir modülün dizinine düşmeyen değişen dosyalar (`<repo>/<yol>`):");
      for (const f of scope.unmapped.slice(0, 80)) lines.push(`- ${f}`);
      lines.push("Mevcut bir modüle aitse o modülü `paths` genişletilmiş hâliyle döndür; değilse yeni modül aç. Silinmiş dosyaları yok say.");
    }
    if (scope.lessons.length) {
      lines.push("\n# Merge edilmiş işlerden dersler");
      lines.push("Bu işler merge edildi; notlar iş sırasında yaşandı. İlgili künyeler yukarıda. Kodla doğrulanan ve o modülde HER İŞTE geçerli olanı `pitfalls`a ekle.");
      lines.push("İşe özgü olanı, kodda artık geçerli olmayanı, mevcut bir tuzağın tekrarını ALMA. Tavan 10: yer açmak için en az değerliyi çıkar.");
      for (const t of scope.lessons) {
        lines.push(`\n## ${t.lessons.title} — künyeler: ${t.modules.join(", ")}`);
        for (const n of t.lessons.notes.slice(0, 40)) lines.push(`- [${n.source}] ${n.text}`);
      }
    }
    if (existing) {
      lines.push(`\nMevcut modül id'leri (\`dependsOn\` için): ${existing.modules.map((m) => `${m.repo}:${m.id}`).join(", ")}`);
    }
    lines.push("\nYalnız güncellediğin ya da eklediğin modülleri içeren bir CODEMAP_JSON bloğu üret.");
  }
  return lines.join("\n");
}

/**
 * Workspace köküne göreli yolu repo adına ve repo köküne göreli yola çevirir.
 * En uzun repo yolu kazanır: iç içe repoda (Northwind'in nested repo'su gibi)
 * dosya dıştakine değil içtekine aittir.
 */
function locate(file: string, repos: readonly Repo[]): { repo: string; path: string } | null {
  const f = file.replace(/\\/g, "/").replace(/^\.\//, "");
  let best: { repo: string; path: string; len: number } | null = null;
  for (const r of repos) {
    const pre = r.path.replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/\/+$/, "");
    if (pre === "") {
      if (!best) best = { repo: r.name, path: f, len: 0 };
    } else if (f.startsWith(`${pre}/`) && pre.length > (best?.len ?? -1)) {
      best = { repo: r.name, path: f.slice(pre.length + 1), len: pre.length };
    }
  }
  return best ? { repo: best.repo, path: best.path } : null;
}

function repoDir(root: string, repo: Repo): string {
  return repo.path === "." ? root : join(root, repo.path);
}
