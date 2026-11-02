import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { BRAND, scrubSecrets } from "@ahtapot/shared";

import { shellQuote, type CommandExecutor } from "../build/executor.js";

const execFileAsync = promisify(execFile);

/**
 * GitHub tarafı — `gh` CLI üzerinden, dar bir arayüzle.
 *
 * Yetki sınırı DevAgent'tan: git token'ı yalnız dal push + draft PR. Merge ve
 * force-push bu arayüzde YOK; agent'ın `gh pr merge` çağırması da ayrıca
 * yasak. Testler sahte istemci verir; motor `gh`'yi bilmez.
 */

/**
 * Host'taki `gh` oturumundan çözülen token — süreç ömrü boyunca bir kez.
 *
 * `null` = henüz bakılmadı, `""` = bakıldı, yok.
 */
let cachedHostToken: string | null = null;

/**
 * GitHub token'ı: önce ortam, sonra host'un `gh` oturumu.
 *
 * YAŞANDI (2026-09-17): `gh auth status` host'ta "Logged in" diyordu ama
 * token **keyring'de** duruyordu, `process.env`te değil. Sunucu yalnız env'e
 * bakıp boş geçiyor, konteynerde `git push` kimliksiz kalıyor ve
 * `could not read Username` ile düşüyordu. `gh auth token` keyring'i okur.
 *
 * Dönen değer `process.env`e YAZILMAZ (kural 5): yalnız çağrı başına
 * `options.env` ile geçer.
 */
export async function resolveToken(): Promise<string> {
  const fromEnv = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  if (fromEnv) return fromEnv;
  if (cachedHostToken !== null) return cachedHostToken;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { encoding: "utf8" });
    cachedHostToken = stdout.trim();
  } catch {
    // `gh` host'ta yok ya da oturum açılmamış: kimliksiz devam, hata mesajı
    // `runRaw` içinde insana ne yapacağını söyler.
    cachedHostToken = "";
  }
  return cachedHostToken;
}

export interface PullRequestRef {
  number: number;
  url: string;
}

/**
 * Açık bir inceleme başlığı (CodeRabbit ya da insan).
 *
 * Check DEĞİL: CodeRabbit'in check'i yorumlarından bağımsız yeşile döner —
 * ölçüldü (PR #135: check SUCCESS, 11 açık yorum). Check'e bakmak yetmiyor.
 */
export interface ReviewThread {
  /** GraphQL düğüm kimliği — aynı başlığı iki kez ele almamak için. */
  id: string;
  /** İlk yorumu yazan (`coderabbitai[bot]`, kullanıcı adı…). */
  author: string;
  path: string;
  line: number | null;
  body: string;
  /** CodeRabbit gövdesinden çıkarılan şiddet; bilinmiyorsa `unknown`. */
  severity: "critical" | "major" | "minor" | "unknown";
}

export interface BlockingReview {
  id: number;
  /** REST kullanıcı adı — bot için `coderabbitai[bot]`. */
  author: string;
  submittedAt: string;
}

export interface ReviewBotStatus {
  headSha: string;
  /** absent: bot henüz durum yazmadı · rate_limited: inceleme YAPILMADI. */
  state: "absent" | "pending" | "done" | "rate_limited";
  description: string;
}

export interface CheckState {
  name: string;
  /** pending: sürüyor · success · failure (skipped/neutral success sayılır). */
  status: "pending" | "success" | "failure";
  /** Actions koşusu adresi (varsa); log çekmek için. */
  detailsUrl?: string;
}

/**
 * Worktree'ye dokunan çağrılar YÜRÜTÜCÜ ister.
 *
 * Worktree named volume'de yaşıyor (2026-09-17 taşıması): host'ta böyle bir
 * dizin yok, `git push` ve `gh pr create` konteynerde koşmalı. GitHub API'sine
 * giden `checks`/`failedLogs` worktree görmez, host'ta kalır.
 */
export interface WorktreeSite {
  executor: CommandExecutor;
  worktree: string;
}

export interface GitHubClient {
  /** Dalı hedef remote'a iter (mirror'a değil). */
  push(site: WorktreeSite, remote: string, branch: string): Promise<void>;
  /** `draft` verilmezse taslak açılır (geriye dönük uyum). */
  createDraftPr(site: WorktreeSite, input: { repo: string; base: string; head: string; title: string; body: string; labels: string[]; draft?: boolean }): Promise<PullRequestRef>;
  /**
   * Uzaktaki bir dalı worktree'ye çeker (`FETCH_HEAD`). `push` gibi konteynerde
   * ve çağrı başına kimlikle koşar: mirror kullanıcının yerel checkout'u,
   * base'in GitHub'daki ucunu bilmez.
   */
  fetch?(site: WorktreeSite, remote: string, ref: string): Promise<void>;
  /**
   * PR'ın base'le birleşebilirliği. `UNKNOWN`: GitHub henüz hesaplamadı
   * (push'tan sonra birkaç saniye) — çakışma sayılmaz, sonraki yoklamada
   * yeniden bakılır.
   */
  mergeState?(repo: string, number: number): Promise<{ mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"; base: string }>;
  checks(repo: string, number: number): Promise<CheckState[]>;
  /** Kırmızı check'lerin başarısız adım logları (kuyruğu, maskelenmiş). */
  failedLogs(repo: string, checks: CheckState[]): Promise<string>;
  /** ÇÖZÜLMEMİŞ inceleme başlıkları. Boş dizi = ele alınacak yorum yok. */
  openReviewThreads?(repo: string, number: number): Promise<ReviewThread[]>;
  /**
   * İnceleme botunun PR head'indeki durumu (`context` adı büyük/küçük harf
   * duyarsız içerilerek eşlenir). Rollup YETMİYOR: açıklama taşımıyor ve bot
   * kota dolunca da `success` yazıyor — "Review rate limited" (ölçüldü,
   * Northwind#153). `headSha` push'tan sonra PR'ın güncellenip güncellenmediğini
   * söyler; GitHub head'i birkaç saniye geç çeviriyor.
   */
  reviewStatus?(repo: string, number: number, context: string): Promise<ReviewBotStatus>;
  /** PR'a yorum yazar — inceleme botunu tetiklemek için (`@coderabbitai review`). Host'ta koşar. */
  commentPr?(repo: string, number: number, body: string): Promise<void>;
  /**
   * Merge'ü hâlâ kilitleyen `CHANGES_REQUESTED` incelemeleri — yazar başına
   * SON KARAR. `COMMENTED` karar değildir, önceki kararı ezmez; GitHub da
   * `reviewDecision`ı böyle hesaplıyor.
   */
  changesRequested?(repo: string, number: number): Promise<BlockingReview[]>;
  /** İncelemeyi dismiss eder — YALNIZ merge onayından sonra, yalnız botunkini. */
  dismissReview?(repo: string, number: number, reviewId: number, message: string): Promise<void>;
  /**
   * PR'ı birleştirir — YALNIZ insan onayından sonra çağrılır.
   *
   * Agent'a kapalıdır (`Bash(gh pr merge*)` reddediliyor); bu yol motorun
   * kendisine ait ve `pr_merge` kapısı onaylanmadan işletilmez.
   */
  merge(repo: string, number: number, method: "merge" | "squash" | "rebase", deleteBranch: boolean): Promise<void>;
  /** Açık issue'lar — worktree gerekmez, host'ta `gh` oturumuyla koşar. */
  listIssues(repo: string): Promise<IssueSummary[]>;
  /** Tek issue: gövde + yorumlar — "bu issue'dan iş aç" panelinin bağlamı. */
  issueDetail(repo: string, number: number): Promise<IssueDetail>;
  /** Kullanıcının erişebildiği repolar — "GitHub'dan seç" akışı. Worktree gerekmez, host'ta `gh` oturumuyla koşar. */
  listRepos(): Promise<RepoSummary[]>;

  // ── Issue'ya yazanlar (tracker senkronu). Host'ta koşar. İsteğe bağlı:
  //    yoksa senkron o adımı atlar.
  /** Token sahibinin kullanıcı adı. */
  selfLogin?(): Promise<string>;
  assignIssue?(repo: string, number: number, change: { add: string[]; remove: string[] }): Promise<void>;
  commentIssue?(repo: string, number: number, body: string): Promise<void>;
  /** Etiket repoda yoksa yaratır, varsa rengini günceller. */
  ensureLabel?(repo: string, name: string, color: string, description: string): Promise<void>;
  setIssueLabels?(repo: string, number: number, change: { add: string[]; remove: string[] }): Promise<void>;
  /** Zaten kapalıysa sessizce geçer. */
  closeIssue?(repo: string, number: number): Promise<void>;

  // ── Repoya dosya önerisi (issue şablonları). Host'ta koşar, worktree yok.
  //    Varsayılan dala YAZMAZ: dal + PR açar, birleştirmek insanın işi.
  /** `paths` varsayılan dalda var mı, `branch`ten açılmış bir PR var mı. */
  filesPrState?(repo: string, branch: string, paths: string[]): Promise<FilesPrState>;
  /** `base`ten `branch` açar (varsa yeniden kullanır), dosyaları yazar, PR açar. */
  openFilesPr?(repo: string, input: {
    base: string; branch: string; title: string; body: string; message: string;
    files: readonly { path: string; content: string }[];
  }): Promise<PullRequestRef>;

  // ── Release: hedef repodaki yayın workflow'u. Host'ta koşar, worktree yok.
  //    Agent'a kapalıdır (DevOps `gh workflow run` reddedilir); yalnız REST
  //    ucu ve zamanlayıcı çağırır.
  defaultBranch?(repo: string): Promise<string>;
  /** `prefix` ile başlayan tag adları (sıra yok; semver sıralaması çağıranın). */
  listTags?(repo: string, prefix: string): Promise<string[]>;
  /** `base...head` arasındaki commit'ler (GitHub en çok 250 döndürür; sayı tam). */
  compareCommits?(repo: string, base: string, head: string): Promise<{ total: number; messages: string[] }>;
  /** Dal ucundaki commit'in birleşik CI durumu; hiç check yoksa `none`. */
  commitCiStatus?(repo: string, ref: string): Promise<CommitCiStatus>;
  /** Dispatch edilebilir (etkin) workflow'lar — UI'daki öneri ve ön doğrulama için. */
  listWorkflows?(repo: string): Promise<WorkflowSummary[]>;
  /** `gh workflow run`: koşu kimliği DÖNMEZ, `listWorkflowRuns` ile eşlenir. */
  dispatchWorkflow?(repo: string, workflow: string, ref: string, inputs: Record<string, string>): Promise<void>;
  /**
   * `since`ten bu yana `workflow_dispatch` ile başlamış TÜM koşular (sayfalı).
   * Sabit bir son-N sınırı, yoğun repoda bizim koşuyu pencerenin dışına iterdi.
   */
  listWorkflowRuns?(repo: string, workflow: string, since: string): Promise<WorkflowRunRef[]>;
  workflowRun?(repo: string, runId: string): Promise<WorkflowRunRef>;
}

export type CommitCiStatus = "success" | "failure" | "pending" | "none";

export interface WorkflowSummary {
  name: string;
  path: string;
}

export interface WorkflowRunRef {
  id: string;
  url: string;
  status: string;
  /** Koşu bitmeden null. */
  conclusion: string | null;
  createdAt: string;
  headBranch: string;
  /** `run-name` (yoksa workflow adı) — korelasyon kimliği burada aranır. */
  title: string;
}

export type FilesPrState =
  /** Tüm dosyalar varsayılan dalda. */
  | { state: "present" }
  /** Öneri PR'ı açık, insan kararı bekleniyor. */
  | { state: "pending"; url: string }
  /** Öneri PR'ı daha önce kapatılmış/birleştirilip sonra silinmiş — tekrar önerilmez. */
  | { state: "declined"; url: string }
  | { state: "missing"; missing: string[]; defaultBranch: string };

export interface IssueSummary {
  number: number;
  /** Issue sayfası — iş detayındaki bağlantı buradan gelir. */
  url: string;
  title: string;
  labels: string[];
  author: string;
  updatedAt: string;
  comments: number;
}

export interface IssueDetail extends IssueSummary {
  body: string;
  thread: { author: string; body: string; createdAt: string }[];
}

export interface RepoSummary {
  nameWithOwner: string;
  description: string | null;
  isPrivate: boolean;
  updatedAt: string;
  defaultBranchRef: string | null;
}

/**
 * CodeRabbit gövdesinden şiddet okur.
 *
 * Biçim: `_🎯 Functional Correctness_ | _🟠 Major_ | _🏗️ Heavy lift_`.
 * Emoji ve İngilizce etiket birlikte aranıyor — biri değişse diğeri tutar.
 */
function severityOf(body: string): ReviewThread["severity"] {
  if (/🔴|\bCritical\b/.test(body)) return "critical";
  if (/🟠|\bMajor\b/.test(body)) return "major";
  if (/🟡|\bMinor\b/.test(body)) return "minor";
  return "unknown";
}

/**
 * İnceleme gövdesinden agent'a bilgi taşımayan kısımları atar: katlı
 * `<details>` blokları (betik çıktısı, AI prompt'u) ve HTML yorumları
 * (parmak izi işaretleri). Başlık, şiddet satırı ve açıklama kalır.
 */
export function stripReviewNoise(body: string): string {
  return body
    .replace(/<details>[\s\S]*?<\/details>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** `https://github.com/owner/repo(.git)` ya da `git@github.com:owner/repo.git` → `owner/repo`. */
export function repoSlugFromRemote(remote: string): string | null {
  const m = /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Workflow tanımlayıcısı: REST `workflow_id` dosya ADI ya da sayısal kimlik
 * ister, yol değil. Profile `.github/workflows/release.yml` yazılırsa
 * `encodeURIComponent` eğik çizgileri kodlar ve sorgu 404 döner; `gh
 * workflow run` da yolu tanımaz. İki çağrı da buradan geçer.
 */
function workflowId(workflow: string): string {
  return workflow.split(/[\\/]/).pop() || workflow;
}

interface RawRun {
  databaseId: number; url: string; status: string; conclusion?: string | null; createdAt: string; headBranch?: string;
  displayTitle?: string;
}

/** `gh` bitmemiş koşuda `conclusion`ı boş dize döndürüyor; null'a indirgenir. */
function toRunRef(r: RawRun): WorkflowRunRef {
  return {
    id: String(r.databaseId),
    url: r.url,
    status: r.status,
    conclusion: r.conclusion ? r.conclusion : null,
    createdAt: r.createdAt,
    headBranch: r.headBranch ?? "",
    title: r.displayTitle ?? "",
  };
}

export class GhCliClient implements GitHubClient {
  private async run(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await execFileAsync(args[0]!, args.slice(1), { cwd: cwd ?? process.cwd(), encoding: "utf8", maxBuffer: 16_000_000 });
    return stdout.trim();
  }

  /**
   * Worktree'nin yanında komut koşturur — yani konteynerde.
   *
   * Token `resolveToken()` ile çözülüp YALNIZ bu çağrının ortamına geçer:
   * konteynerde `gh` kimliği yok, ama kural 5 gereği kimlik `process.env`e
   * yazılmaz ve konteynerin kalıcı ortamına da girmez.
   */
  private async runAt(site: WorktreeSite, args: string[]): Promise<string> {
    const lines: string[] = [];
    const token = await resolveToken();
    const res = await site.executor.run({
      command: args.map(shellQuote).join(" "),
      cwd: site.worktree,
      env: token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {},
      timeoutMs: 600_000,
      onLine: (_s, line) => {
        lines.push(line);
      },
    });
    const out = lines.join("\n").trim();
    if (res.exitCode !== 0) {
      throw new Error(`komut düştü (${res.exitCode}): ${args[0]}\n${scrubSecrets(out).slice(0, 2000)}`);
    }
    return out;
  }

  /**
   * Hazır bir kabuk satırını koşturur — `runAt` gibi ama argüman quote'lamaz.
   *
   * Zincirleme (`&&`) gereken tek yer `push`: credential helper kurulumu ile
   * itme AYNI çağrıda olmalı, yoksa token kalıcı yapılandırmaya sızar.
   * `label` yalnız hata mesajı içindir.
   */
  private async runRaw(site: WorktreeSite, command: string, label: string): Promise<string> {
    const lines: string[] = [];
    const token = await resolveToken();
    const res = await site.executor.run({
      command,
      cwd: site.worktree,
      env: token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {},
      timeoutMs: 600_000,
      onLine: (_s, line) => {
        lines.push(line);
      },
    });
    const out = lines.join("\n").trim();
    if (res.exitCode !== 0) {
      // Kimlik yokluğu en sık düşme sebebi; mesaj insana ne yapacağını söylesin.
      const hint = !token
        ? "\n\nGH_TOKEN/GITHUB_TOKEN sunucu ortamında tanımlı değil; PR adımı kimliksiz koşamaz."
        : "";
      throw new Error(`komut düştü (${res.exitCode}): ${label}\n${scrubSecrets(out).slice(0, 2000)}${hint}`);
    }
    return out;
  }

  async push(site: WorktreeSite, remote: string, branch: string): Promise<void> {
    // `-u` yok: worktree'nin origin'i mirror'dır, üst dal ayarını bozmayalım.
    //
    // YAŞANDI (2026-09-17): yalın `git push` konteynerde
    // `fatal: could not read Username for 'https://github.com'` ile düştü.
    // `GH_TOKEN` **git'in değil `gh`'ın** değişkeni; git onu tanımaz, HTTPS
    // remote'ta credential helper'a sorar, tty olmadığı için okuyamaz.
    //
    // `gh auth setup-git` git'e `gh` tabanlı bir helper takar; `gh` kimliği
    // `GH_TOKEN`dan okur. Kurulum push ile AYNI çağrıda yapılır: `runAt`
    // ortamı çağrı başına verdiği için token kalıcı bir yere yazılmaz
    // (kural 5). `-h github.com`: yalnız bu host için helper takılır.
    await this.runRaw(
      site,
      `gh auth setup-git -h github.com && git push ${shellQuote(remote)} ${shellQuote(`HEAD:refs/heads/${branch}`)}`,
      "git push",
    );
  }

  async fetch(site: WorktreeSite, remote: string, ref: string): Promise<void> {
    // Kimlik `push`taki gibi: helper kurulumu ve fetch AYNI çağrıda (kural 5).
    // `--depth` YOK: sığ geçmişte merge-base bulunamaz.
    await this.runRaw(
      site,
      `gh auth setup-git -h github.com && git fetch ${shellQuote(remote)} ${shellQuote(ref)}`,
      "git fetch",
    );
  }

  async mergeState(repo: string, number: number): Promise<{ mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"; base: string }> {
    const raw = await this.run(["gh", "pr", "view", String(number), "-R", repo, "--json", "mergeable,baseRefName"]);
    const parsed = JSON.parse(raw) as { mergeable?: string; baseRefName?: string };
    const m = parsed.mergeable;
    return {
      mergeable: m === "MERGEABLE" || m === "CONFLICTING" ? m : "UNKNOWN",
      base: parsed.baseRefName ?? "",
    };
  }

  async createDraftPr(site: WorktreeSite, input: { repo: string; base: string; head: string; title: string; body: string; labels: string[]; draft?: boolean }): Promise<PullRequestRef> {
    // `--draft` ARTIK SABİT DEĞİL: profilde `git.pr.draft` alanı zaten vardı
    // ama motor onu yok sayıp her PR'ı taslak açıyordu. Karar projenin.
    // Değerler bayrağa `=` ile bağlı: sabit index'e `splice` (4) `--draft`'ı
    // `-R` ile değerinin arasına sokuyordu → `-R --draft <repo>`, gh
    // "unknown argument <repo>" (yaşandı, iki kez). Bitişik yazımda hiçbir
    // ekleme sırası ya da araya giren argüman değeri bayrağından ayıramaz.
    const args = [
      "gh", "pr", "create", `--repo=${input.repo}`, `--base=${input.base}`, `--head=${input.head}`,
      `--title=${input.title}`, `--body=${input.body}`,
    ];
    if (input.draft !== false) args.push("--draft");
    for (const l of input.labels) args.push(`--label=${l}`);
    const url = (await this.runAt(site, args)).split("\n").find((l) => l.startsWith("https://")) ?? "";
    const num = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);
    if (!num) throw new Error(`PR adresi çözülemedi: ${url || "(boş)"}`);
    return { number: num, url };
  }

  /**
   * Çözülmemiş inceleme başlıkları — GraphQL, çünkü `isResolved` REST'te yok.
   *
   * `isOutdated` olanlar elenir: yorumun değindiği satır artık başka, yeni
   * push onu geçersiz kılmış demektir. Kapatılmamış ama geçersiz bir yorum
   * için agent koşturmak sonsuz döngü olurdu.
   */
  async openReviewThreads(repo: string, number: number): Promise<ReviewThread[]> {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return [];
    const query = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    reviewThreads(first:100){ nodes{ id isResolved isOutdated path line
      comments(first:1){ nodes{ author{login} body } } } } } } }`;
    let raw: string;
    try {
      raw = await this.run(["gh", "api", "graphql", "-f", `query=${query}`,
        "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`]);
    } catch {
      // İnceleme okunamıyorsa akış durmaz: yorum yokmuş gibi devam edilir.
      return [];
    }
    const parsed = JSON.parse(raw) as {
      data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: {
        id?: string; isResolved?: boolean; isOutdated?: boolean; path?: string; line?: number | null;
        comments?: { nodes?: { author?: { login?: string }; body?: string }[] };
      }[] } } } };
    };
    const nodes = parsed.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    const out: ReviewThread[] = [];
    for (const t of nodes) {
      if (t.isResolved || t.isOutdated) continue;
      const first = t.comments?.nodes?.[0];
      const body = first?.body ?? "";
      out.push({
        id: t.id ?? `${t.path ?? "?"}:${t.line ?? "?"}`,
        author: first?.author?.login ?? "?",
        path: t.path ?? "?",
        line: t.line ?? null,
        // Gövde uzun olabiliyor (CodeRabbit betik çıktısı gömüyor); prompta
        // sığması için kırpılır. Gürültü KIRPMADAN ÖNCE atılır: CodeRabbit
        // gövdesi `<details>` (statik analiz çıktısı) ile başlıyor ve asıl
        // metin 1500 karakterin dışında kalıyordu (ölçüldü, Northwind#152).
        body: scrubSecrets(stripReviewNoise(body)).slice(0, 2500),
        severity: severityOf(body),
      });
    }
    return out;
  }

  async reviewStatus(repo: string, number: number, context: string): Promise<ReviewBotStatus> {
    const headSha = await this.run(["gh", "pr", "view", String(number), "-R", repo, "--json", "headRefOid", "--jq", ".headRefOid"]);
    // Birleşik durum bağlam başına EN SON kaydı döner.
    const raw = await this.run(["gh", "api", `repos/${repo}/commits/${headSha}/status`]);
    const parsed = JSON.parse(raw) as { statuses?: { context?: string; state?: string; description?: string | null }[] };
    const s = (parsed.statuses ?? []).find((x) => (x.context ?? "").toLowerCase().includes(context.toLowerCase()));
    if (!s) return { headSha, state: "absent", description: "" };
    const description = s.description ?? "";
    if (s.state === "pending") return { headSha, state: "pending", description };
    return { headSha, state: /rate.?limit/i.test(description) ? "rate_limited" : "done", description };
  }

  async commentPr(repo: string, number: number, body: string): Promise<void> {
    await this.run(["gh", "pr", "comment", String(number), "-R", repo, "--body", body]);
  }

  async changesRequested(repo: string, number: number): Promise<BlockingReview[]> {
    // `--paginate` + `--jq '.[]'`: sayfalar tek dizi olarak birleşmiyor,
    // satır başına bir inceleme almak her iki durumda da doğru.
    const raw = await this.run(["gh", "api", "--paginate", `repos/${repo}/pulls/${number}/reviews`,
      "--jq", ".[] | {id, state, submitted_at, login: .user.login}"]);
    const last = new Map<string, { id: number; state: string; submittedAt: string }>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { id: number; state: string; submitted_at?: string; login?: string };
      if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) continue;
      // API sırası kronolojik; sonraki karar öncekini ezer.
      last.set(r.login ?? "?", { id: r.id, state: r.state, submittedAt: r.submitted_at ?? "" });
    }
    return [...last].filter(([, r]) => r.state === "CHANGES_REQUESTED")
      .map(([author, r]) => ({ id: r.id, author, submittedAt: r.submittedAt }));
  }

  async dismissReview(repo: string, number: number, reviewId: number, message: string): Promise<void> {
    await this.run(["gh", "api", "-X", "PUT", `repos/${repo}/pulls/${number}/reviews/${reviewId}/dismissals`,
      "-f", `message=${message}`, "-f", "event=DISMISS"]);
  }

  async merge(repo: string, number: number, method: "merge" | "squash" | "rebase", deleteBranch: boolean): Promise<void> {
    // Host'ta koşar: worktree gerekmiyor, `gh` kendi keyring oturumunu kullanır.
    const flag = method === "squash" ? "--squash" : method === "rebase" ? "--rebase" : "--merge";
    const args = ["gh", "pr", "merge", String(number), "-R", repo, flag];
    // Taslak PR merge edilemez; onay geldiyse hazır sayılır.
    await this.run(["gh", "pr", "ready", String(number), "-R", repo]).catch(() => undefined);
    if (deleteBranch) args.push("--delete-branch");
    await this.run(args);
  }

  /**
   * Açık issue'lar. Host'ta koşar (worktree yok) — sağdaki listeleme ekranı
   * iş açılmadan önce, iş henüz yokken görünür olmalı.
   */
  async listIssues(repo: string): Promise<IssueSummary[]> {
    const raw = await this.run([
      "gh", "issue", "list", "-R", repo, "--state", "open", "--limit", "100",
      "--json", "number,url,title,labels,author,updatedAt,comments",
    ]);
    const parsed = JSON.parse(raw) as {
      number: number; url?: string; title: string; labels?: { name: string }[];
      author?: { login?: string }; updatedAt: string; comments?: unknown[];
    }[];
    return parsed.map((i) => ({
      number: i.number,
      url: i.url ?? `https://github.com/${repo}/issues/${i.number}`,
      title: i.title,
      labels: (i.labels ?? []).map((l) => l.name),
      author: i.author?.login ?? "?",
      updatedAt: i.updatedAt,
      comments: i.comments?.length ?? 0,
    }));
  }

  /**
   * Kullanıcının erişebildiği repolar. Host'ta koşar (worktree yok) —
   * "workspace bağla" formunda proje henüz yokken repo seçmek için.
   *
   * `gh repo list` owner verilmeden yalnız kullanıcının KENDİ hesabının
   * repolarını listeler, organizasyonları GETİRMEZ — kapsam dışı bırakıldı.
   * Varsayılan limit 30; formda yüzlerce repo olabileceğinden 200'e çıkarıldı.
   */
  async listRepos(): Promise<RepoSummary[]> {
    const raw = await this.run([
      "gh", "repo", "list", "--limit", "200",
      "--json", "nameWithOwner,description,isPrivate,updatedAt,defaultBranchRef",
    ]);
    const parsed = JSON.parse(raw) as {
      nameWithOwner: string; description?: string | null; isPrivate: boolean;
      updatedAt: string; defaultBranchRef?: { name?: string } | null;
    }[];
    return parsed.map((r) => ({
      nameWithOwner: r.nameWithOwner,
      description: r.description || null,
      isPrivate: r.isPrivate,
      updatedAt: r.updatedAt,
      defaultBranchRef: r.defaultBranchRef?.name ?? null,
    }));
  }

  async defaultBranch(repo: string): Promise<string> {
    return await this.run(["gh", "api", `repos/${repo}`, "--jq", ".default_branch"]);
  }

  /**
   * `git/matching-refs` öneke göre süzer: `repos/:r/tags` tüm tag'leri
   * (sürüm olmayanlar dahil) sayfa sayfa döker ve semver sırası vermez.
   */
  async listTags(repo: string, prefix: string): Promise<string[]> {
    const raw = await this.run([
      "gh", "api", "--paginate", `repos/${repo}/git/matching-refs/tags/${prefix}`, "--jq", ".[].ref",
    ]);
    return raw.split("\n").map((l) => l.trim()).filter(Boolean).map((r) => r.replace(/^refs\/tags\//, ""));
  }

  async compareCommits(repo: string, base: string, head: string): Promise<{ total: number; messages: string[] }> {
    const raw = await this.run([
      "gh", "api", `repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      "--jq", "{total: .total_commits, messages: [.commits[].commit.message]}",
    ]);
    const parsed = JSON.parse(raw) as { total?: number; messages?: string[] };
    return { total: parsed.total ?? 0, messages: parsed.messages ?? [] };
  }

  /**
   * Check-run'lar (Actions) ve eski commit status'ları (harici CI) AYRI
   * uçlarda; ikisine birden bakılmazsa yalnız biriyle çalışan repo hep
   * "check yok" görünürdü.
   */
  async commitCiStatus(repo: string, ref: string): Promise<CommitCiStatus> {
    const r = encodeURIComponent(ref);
    const runs = JSON.parse(await this.run([
      "gh", "api", `repos/${repo}/commits/${r}/check-runs?per_page=100`,
      "--jq", "[.check_runs[] | {status, conclusion}]",
    ])) as { status: string; conclusion: string | null }[];
    const combined = JSON.parse(await this.run([
      "gh", "api", `repos/${repo}/commits/${r}/status`, "--jq", "{state, total: .total_count}",
    ])) as { state: string; total: number };

    if (runs.length === 0 && combined.total === 0) return "none";
    const runFailed = runs.some((c) => c.status === "completed" && !["success", "neutral", "skipped"].includes(c.conclusion ?? ""));
    if (runFailed || (combined.total > 0 && (combined.state === "failure" || combined.state === "error"))) return "failure";
    const runPending = runs.some((c) => c.status !== "completed");
    if (runPending || (combined.total > 0 && combined.state === "pending")) return "pending";
    return "success";
  }

  async listWorkflows(repo: string): Promise<WorkflowSummary[]> {
    const raw = await this.run(["gh", "workflow", "list", "-R", repo, "--json", "name,path,state", "--limit", "100"]);
    const parsed = JSON.parse(raw) as { name: string; path: string; state: string }[];
    return parsed.filter((w) => w.state === "active").map((w) => ({ name: w.name, path: w.path }));
  }

  async dispatchWorkflow(repo: string, workflow: string, ref: string, inputs: Record<string, string>): Promise<void> {
    const fields = Object.entries(inputs).flatMap(([k, v]) => ["-f", `${k}=${v}`]);
    await this.run(["gh", "workflow", "run", workflowId(workflow), "-R", repo, "--ref", ref, ...fields]);
  }

  /**
   * REST ucu, `gh run list` değil: `gh run list` tarih süzgeci ve sayfalama
   * vermiyor, yalnız son N koşu. `--paginate` + `--jq` her koşuyu bir JSON
   * satırı olarak döker; sayfalar dizi olarak birleştirilemiyor.
   */
  async listWorkflowRuns(repo: string, workflow: string, since: string): Promise<WorkflowRunRef[]> {
    const query = `event=workflow_dispatch&per_page=100&created=${encodeURIComponent(`>=${since}`)}`;
    const raw = await this.run([
      "gh", "api", "--paginate",
      `repos/${repo}/actions/workflows/${encodeURIComponent(workflowId(workflow))}/runs?${query}`,
      "--jq", ".workflow_runs[] | {databaseId: .id, url: .html_url, status, conclusion, createdAt: .created_at, headBranch: .head_branch, displayTitle: .display_title}",
    ]);
    return raw.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => toRunRef(JSON.parse(l) as RawRun));
  }

  async workflowRun(repo: string, runId: string): Promise<WorkflowRunRef> {
    const raw = await this.run([
      "gh", "run", "view", runId, "-R", repo, "--json", "databaseId,url,status,conclusion,createdAt,headBranch,displayTitle",
    ]);
    return toRunRef(JSON.parse(raw) as RawRun);
  }

  /** Gövde + yorumlar — Planner'ın ilk bağlamı bundan derlenir. */
  async issueDetail(repo: string, number: number): Promise<IssueDetail> {
    const raw = await this.run([
      "gh", "issue", "view", String(number), "-R", repo,
      "--json", "number,url,title,labels,author,updatedAt,body,comments",
    ]);
    const parsed = JSON.parse(raw) as {
      number: number; url?: string; title: string; labels?: { name: string }[];
      author?: { login?: string }; updatedAt: string; body?: string;
      comments?: { author?: { login?: string }; body?: string; createdAt?: string }[];
    };
    const thread = parsed.comments ?? [];
    return {
      number: parsed.number,
      url: parsed.url ?? `https://github.com/${repo}/issues/${parsed.number}`,
      title: parsed.title,
      labels: (parsed.labels ?? []).map((l) => l.name),
      author: parsed.author?.login ?? "?",
      updatedAt: parsed.updatedAt,
      comments: thread.length,
      body: parsed.body ?? "",
      thread: thread.map((c) => ({
        author: c.author?.login ?? "?",
        body: c.body ?? "",
        createdAt: c.createdAt ?? "",
      })),
    };
  }

  private login: string | null = null;

  async selfLogin(): Promise<string> {
    this.login ??= await this.run(["gh", "api", "user", "--jq", ".login"]);
    return this.login;
  }

  async assignIssue(repo: string, number: number, change: { add: string[]; remove: string[] }): Promise<void> {
    const args = ["gh", "issue", "edit", String(number), "-R", repo];
    for (const a of change.add) args.push("--add-assignee", a);
    for (const r of change.remove) args.push("--remove-assignee", r);
    if (args.length > 6) await this.run(args);
  }

  async commentIssue(repo: string, number: number, body: string): Promise<void> {
    await this.run(["gh", "issue", "comment", String(number), "-R", repo, "--body", body]);
  }

  async ensureLabel(repo: string, name: string, color: string, description: string): Promise<void> {
    // `--force`: varsa günceller — ilk çağrıda yaratmak için ayrı bir okuma gerekmez.
    await this.run(["gh", "label", "create", name, "-R", repo, "--color", color, "--description", description, "--force"]);
  }

  async setIssueLabels(repo: string, number: number, change: { add: string[]; remove: string[] }): Promise<void> {
    const args = ["gh", "issue", "edit", String(number), "-R", repo];
    for (const a of change.add) args.push("--add-label", a);
    for (const r of change.remove) args.push("--remove-label", r);
    if (args.length > 6) await this.run(args);
  }

  async closeIssue(repo: string, number: number): Promise<void> {
    const raw = await this.run(["gh", "issue", "view", String(number), "-R", repo, "--json", "state"]);
    if ((JSON.parse(raw) as { state?: string }).state === "CLOSED") return;
    await this.run(["gh", "issue", "close", String(number), "-R", repo, "--reason", "completed"]);
  }

  async filesPrState(repo: string, branch: string, paths: string[]): Promise<FilesPrState> {
    const defaultBranch = await this.run(["gh", "api", `repos/${repo}`, "--jq", ".default_branch"]);
    const missing: string[] = [];
    for (const p of paths) {
      if ((await this.contentSha(repo, p, defaultBranch)) === null) missing.push(p);
    }
    if (missing.length === 0) return { state: "present" };

    const raw = await this.run(["gh", "pr", "list", "-R", repo, "--head", branch, "--state", "all", "--json", "url,state"]);
    const prs = JSON.parse(raw) as { url: string; state: string }[];
    const open = prs.find((p) => p.state === "OPEN");
    if (open) return { state: "pending", url: open.url };
    // Kapatılmış ya da birleştirilip sonradan silinmiş: ikisi de insanın
    // "istemiyorum" cevabı. Bağlanma akışı her seferinde yeniden sormamalı.
    const closed = prs[0];
    if (closed) return { state: "declined", url: closed.url };
    return { state: "missing", missing, defaultBranch };
  }

  async openFilesPr(repo: string, input: {
    base: string; branch: string; title: string; body: string; message: string;
    files: readonly { path: string; content: string }[];
  }): Promise<PullRequestRef> {
    const sha = await this.run(["gh", "api", `repos/${repo}/git/ref/heads/${input.base}`, "--jq", ".object.sha"]);
    try {
      await this.run(["gh", "api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${input.branch}`, "-f", `sha=${sha}`]);
    } catch (err) {
      // PR'sız kalmış eski bir dal (yarıda düşmüş deneme) yeniden kullanılır.
      // Sıfırlanmaz: bu arayüzde force-push yok.
      if (!String(err instanceof Error ? err.message : err).includes("Reference already exists")) throw err;
    }
    for (const f of input.files) {
      const existing = await this.contentSha(repo, f.path, input.branch);
      const args = [
        "gh", "api", "-X", "PUT", `repos/${repo}/contents/${f.path}`,
        "-f", `message=${input.message}`,
        "-f", `content=${Buffer.from(f.content, "utf8").toString("base64")}`,
        "-f", `branch=${input.branch}`,
      ];
      if (existing) args.push("-f", `sha=${existing}`);
      await this.run(args);
    }
    const out = await this.run([
      "gh", "pr", "create", `--repo=${repo}`, `--base=${input.base}`, `--head=${input.branch}`,
      `--title=${input.title}`, `--body=${input.body}`,
    ]);
    const url = out.split("\n").find((l) => l.startsWith("https://")) ?? "";
    return { number: Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0), url };
  }

  /** Dosyanın blob sha'sı; yoksa `null`. 404 dışındaki hata (yetki, ağ) fırlar. */
  private async contentSha(repo: string, path: string, ref: string): Promise<string | null> {
    try {
      return await this.run(["gh", "api", `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, "--jq", ".sha"]);
    } catch (err) {
      if (String(err instanceof Error ? err.message : err).includes("HTTP 404")) return null;
      throw err;
    }
  }

  async checks(repo: string, number: number): Promise<CheckState[]> {
    const raw = await this.run(["gh", "pr", "view", String(number), "-R", repo, "--json", "statusCheckRollup"]);
    const parsed = JSON.parse(raw) as { statusCheckRollup?: { name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string; targetUrl?: string }[] };
    return (parsed.statusCheckRollup ?? []).map((c) => {
      const name = c.name ?? c.context ?? "?";
      // CheckRun: status COMPLETED + conclusion; StatusContext: state.
      const concl = (c.conclusion ?? c.state ?? "").toUpperCase();
      const done = c.status ? c.status.toUpperCase() === "COMPLETED" : concl !== "PENDING" && concl !== "";
      const detailsUrl = c.detailsUrl ?? c.targetUrl;
      if (!done) return { name, status: "pending" as const, ...(detailsUrl ? { detailsUrl } : {}) };
      const ok = ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(concl);
      return { name, status: ok ? ("success" as const) : ("failure" as const), ...(detailsUrl ? { detailsUrl } : {}) };
    });
  }

  /**
   * `gh run view <id> --log-failed`: Actions koşusunun yalnız kırmızı
   * adımları. Koşu kimliği check'in detailsUrl'inden (`/actions/runs/<id>`).
   * Kuyruk sınırlı ve maskeli — CI logu megabaytlarca olabilir, sır taşıyabilir.
   */
  async failedLogs(repo: string, checks: CheckState[]): Promise<string> {
    const runIds = new Set<string>();
    for (const c of checks) {
      if (c.status !== "failure") continue;
      const id = /\/actions\/runs\/(\d+)/.exec(c.detailsUrl ?? "")?.[1];
      if (id) runIds.add(id);
    }
    const parts: string[] = [];
    for (const id of runIds) {
      try {
        const log = await this.run(["gh", "run", "view", id, "-R", repo, "--log-failed"]);
        parts.push(`### run ${id}\n${log.split("\n").slice(-200).join("\n")}`);
      } catch (e) {
        parts.push(`### run ${id}\n(log alınamadı: ${e instanceof Error ? e.message : String(e)})`);
      }
    }
    return scrubSecrets(parts.join("\n\n"));
  }
}

/** PR gövdesi: iş + plan özeti + test sonuçları; sır taşımaz (maskelenmiş özetler). */
export function renderPrBody(input: { title: string; description: string; planSummary: string; phases: string[]; tests: string[]; closesIssue?: number }): string {
  return [
    `## ${input.title}`,
    input.description ? `\n${input.description}` : "",
    "\n## Plan", input.planSummary,
    ...input.phases.map((p) => `- ${p}`),
    "\n## Testler", ...input.tests.map((t) => `- ${t}`),
    // GitHub issue'dan açılan işte: PR birleşince issue otomatik kapanır.
    input.closesIssue ? `\nCloses #${input.closesIssue}` : "",
    `\n_${BRAND.displayName} tarafından açıldı; insan onayından sonra._`,
  ].filter(Boolean).join("\n");
}
