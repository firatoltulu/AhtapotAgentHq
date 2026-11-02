import { eq } from "drizzle-orm";

import { activeProfile } from "../analyst/analyst.js";
import { schema, type Db } from "../db/index.js";
import { repoSlugFromRemote, type GitHubClient } from "../git/github.js";
import { STAGES, stageLabelName, type StageKey } from "./stages.js";
import { SYNC_MARKER, type ExternalRef, type IssueTracker, type VerdictLabels, type VerdictRead } from "./types.js";

interface IssueAddr {
  repo: string;
  number: number;
}

/** GitHub issue adaptörü — `gh` oturumu (token sahibi) adına yazar. */
export class GithubIssueTracker implements IssueTracker {
  readonly source = "github_issue";

  constructor(
    private readonly db: Db,
    private readonly gh: GitHubClient,
  ) {}

  /**
   * Önce `externalUrl` (iş açılırken issue sayfasından gelir). Eski işlerde
   * yalnız `#N` var: repo projenin kaynağından ya da birincil remote'undan.
   */
  private addr(ref: ExternalRef): IssueAddr | null {
    const m = ref.externalUrl ? /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/.exec(ref.externalUrl) : null;
    if (m) return { repo: m[1]!, number: Number(m[2]) };
    const number = Number(ref.externalRef?.replace("#", ""));
    if (!number) return null;
    const project = this.db
      .select({ sourceGitUrl: schema.projects.sourceGitUrl })
      .from(schema.projects)
      .where(eq(schema.projects.id, ref.projectId))
      .get();
    const primary = activeProfile(this.db, ref.projectId)?.workspace.repos.find((r) => r.primary)?.remote;
    const repo =
      (project?.sourceGitUrl ? repoSlugFromRemote(project.sourceGitUrl) : null) ??
      (primary ? repoSlugFromRemote(primary) : null);
    return repo ? { repo, number } : null;
  }

  private need(ref: ExternalRef): IssueAddr {
    const a = this.addr(ref);
    if (!a) throw new Error(`issue adresi çözülemedi (${ref.externalRef ?? "?"})`);
    return a;
  }

  async assignToSelf(ref: ExternalRef): Promise<void> {
    const a = this.need(ref);
    await this.gh.assignIssue?.(a.repo, a.number, { add: ["@me"], remove: [] });
  }

  async assignToReporter(ref: ExternalRef): Promise<void> {
    const a = this.need(ref);
    const { author } = await this.gh.issueDetail(a.repo, a.number);
    const self = await this.gh.selfLogin?.();
    // Issue'yu token sahibi açtıysa çıkarıp geri eklemek anlamsız bir olay üretir.
    if (!author || author === "?" || author === self) return;
    await this.gh.assignIssue?.(a.repo, a.number, { add: [author], remove: ["@me"] });
  }

  async comment(ref: ExternalRef, markdown: string): Promise<void> {
    const a = this.need(ref);
    await this.gh.commentIssue?.(a.repo, a.number, markdown);
  }

  async setStage(ref: ExternalRef, stage: StageKey, prefix: string): Promise<void> {
    if (!this.gh.setIssueLabels || !this.gh.ensureLabel) return;
    const a = this.need(ref);
    const target = stageLabelName(prefix, stage);
    await this.gh.ensureLabel(a.repo, target, STAGES[stage].color, "Ahtapot iş aşaması");
    // Yalnız issue'da GERÇEKTEN duran eski aşama etiketleri çıkarılır: repoda
    // olmayan bir etiketi `--remove-label` ile istemek `gh`'yi düşürür.
    const { labels } = await this.gh.issueDetail(a.repo, a.number);
    const stale = labels.filter((l) => l.startsWith(`${prefix}: `) && l !== target);
    await this.gh.setIssueLabels(a.repo, a.number, { add: labels.includes(target) ? [] : [target], remove: stale });
  }

  async close(ref: ExternalRef): Promise<void> {
    const a = this.need(ref);
    await this.gh.closeIssue?.(a.repo, a.number);
  }

  async prepareVerdict(ref: ExternalRef, labels: VerdictLabels): Promise<void> {
    if (!this.gh.setIssueLabels || !this.gh.ensureLabel) return;
    const a = this.need(ref);
    // Etiket repoda yoksa insan issue'da seçemez; kapı her açıldığında garanti edilir.
    await this.gh.ensureLabel(a.repo, labels.approve, "0E8A16", "Ahtapot canlı test: geçti, QA'ya geç");
    await this.gh.ensureLabel(a.repo, labels.fix, "D93F0B", "Ahtapot canlı test: düzeltme iste (notu yorum olarak yaz)");
    // Önceki turdan kalan etiket yeni turu kendiliğinden kararlaştırmasın.
    await this.clearVerdict(ref, labels);
  }

  async readVerdict(ref: ExternalRef, labels: VerdictLabels, since: string): Promise<VerdictRead> {
    const a = this.need(ref);
    const d = await this.gh.issueDetail(a.repo, a.number);
    const after = Date.parse(since);
    return {
      approve: d.labels.includes(labels.approve),
      fix: d.labels.includes(labels.fix),
      notes: d.thread
        .filter((c) => Date.parse(c.createdAt) > after && !c.body.includes(SYNC_MARKER) && c.body.trim() !== "")
        .map((c) => c.body.trim()),
    };
  }

  async clearVerdict(ref: ExternalRef, labels: VerdictLabels): Promise<void> {
    if (!this.gh.setIssueLabels) return;
    const a = this.need(ref);
    // Yalnız issue'da duranlar: olmayan etiketi `--remove-label` ile istemek `gh`'yi düşürür.
    const { labels: current } = await this.gh.issueDetail(a.repo, a.number);
    const remove = [labels.approve, labels.fix].filter((l) => current.includes(l));
    if (remove.length > 0) await this.gh.setIssueLabels(a.repo, a.number, { add: [], remove });
  }
}
