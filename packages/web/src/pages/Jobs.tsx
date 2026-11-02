import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { BRAND } from "@ahtapot/shared";

import {
  api,
  type Drift,
  type GithubIssueWithJob,
  type Job,
  type Project,
} from "../api";
import { ExtrasFields, withRelatedFiles, type UploadedFile } from "../components/JobExtras";
import { Markdown } from "../components/Markdown";
import { groupOf, type JobGroup } from "../components/jobGroups";
import { toast } from "../toast";
import { Dot, ErrorText, fmtAge, fmtClock, fmtUsd, gateLabel, inputClass, isGateState, jobTone, type Tone } from "../ui";

/**
 * İşler ekranı — iş listesi, TÜM workspace'lerin GitHub issue'ları ve iş açma.
 *
 * Eskiden issue listesi proje sayfasında ayrı bir sekmeydi; iş açmanın iki
 * yolu (issue'dan / issue'suz) iki ekrana dağılmıştı. Tek ekranda: sol sütun
 * workspace + durum filtresi, orta sütun liste, sağ sütun iş açma paneli ve
 * açma kriterleri. Kriterler sunucunun reddedeceği isteği göndermeden önce
 * görünür kılar (onaysız profil, issue'ya bağlı açık iş) — sunucu yine de
 * kendisi denetler (409), buradaki yalnız ön gösterim.
 *
 * Filtre URL'de (`ws`, `tab`): proje sayfasından `?ws=<id>` ile gelinir.
 */

type Tab = "jobs" | "issues";
/**
 * Bitmiş/iptal işler varsayılan listede yok: biriktikçe dikkat isteyen işleri
 * aşağı itiyorlardı. "Arşiv" ve alt kovaları ayrı bir görünümdür.
 */
type StatusGroup = "active" | Exclude<JobGroup, "done"> | "archive" | "done" | "cancel";
type IssueFilter = "open" | "free" | "linked" | "brand";
/**
 * Issue formunun boş bırakılan isteğe bağlı alanları gövdeye
 * `### Başlık\n\n_No response_` olarak düşer. Planner'a bilgi taşımaz,
 * yalnız gürültü; iş açıklamasına girmeden ayıklanır.
 */
function stripEmptyFormFields(body: string): string {
  return body.replace(/^###[^\r\n]*(?:\r?\n)+_No response_[ \t]*(?:(?:\r?\n)+|$)/gm, "").trim();
}

type Draft = { title: string; description: string; relatedFiles: string[]; referencePaths: string[]; attachments: UploadedFile[] };

const EMPTY_DRAFT: Draft = { title: "", description: "", relatedFiles: [], referencePaths: [], attachments: [] };

interface IssueRow extends GithubIssueWithJob {
  projectId: string;
  projectName: string;
  repo: string;
}

export function JobsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  // `projectId` eski bağlantılar için (iş detayı vb. hâlâ onu verebilir).
  const ws = params.get("ws") ?? params.get("projectId") ?? "all";
  const tab: Tab = params.get("tab") === "issues" ? "issues" : "jobs";
  const setFilter = (next: { ws?: string; tab?: Tab }) => {
    const p = new URLSearchParams(params);
    p.delete("projectId");
    if (next.ws !== undefined) {
      if (next.ws === "all") p.delete("ws");
      else p.set("ws", next.ws);
    }
    if (next.tab !== undefined) {
      if (next.tab === "jobs") p.delete("tab");
      else p.set("tab", next.tab);
    }
    setParams(p, { replace: true });
  };

  const [status, setStatus] = useState<StatusGroup>("active");
  const [issueFilter, setIssueFilter] = useState<IssueFilter>("open");
  const [search, setSearch] = useState("");
  const [panel, setPanel] = useState<"new" | "issue">("new");
  const [sel, setSel] = useState<{ projectId: string; number: number } | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  // Issue taslağı hangi issue'ya ait olduğunu taşır: seçim değişince eski
  // issue'nun metni yenisinin formunda kalmasın.
  const [issueDraft, setIssueDraft] = useState<(Draft & { key: string }) | null>(null);

  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects, refetchInterval: 15_000 });
  const jobs = useQuery({ queryKey: ["jobs", ""], queryFn: () => api.jobs(), refetchInterval: 5000 });
  const system = useQuery({ queryKey: ["system"], queryFn: api.system, refetchInterval: 30_000 });
  // `gh issue list` her workspace için ayrı süreç — 5 sn'lik yoklamaya uygun
  // değil. Elle "Yenile" ya da iş açılınca tazelenir.
  const issues = useQuery({ queryKey: ["github-issues-all"], queryFn: api.allGithubIssues, staleTime: 60_000 });

  const projectList = projects.data ?? [];
  // Bayatlık workspace taraması ister (dosya imzaları); liste ucuna koymak her
  // yoklamada tüm workspace'leri tarardı. Yalnız onaylı profilli projeler, seyrek.
  const drifts = useQueries({
    queries: projectList
      .filter((p) => p.activeProfileId)
      .map((p) => ({ queryKey: ["drift", p.id], queryFn: () => api.drift(p.id), staleTime: 5 * 60_000 })),
  });
  const driftOf = new Map<string, Drift>();
  projectList.filter((p) => p.activeProfileId).forEach((p, i) => {
    const d = drifts[i]?.data;
    if (d) driftOf.set(p.id, d);
  });

  const nameOf = (id: string) => projectList.find((p) => p.id === id)?.name ?? id;
  const inWs = (projectId: string) => ws === "all" || projectId === ws;
  const q = search.trim().toLowerCase();

  const allJobs = jobs.data ?? [];
  const wsJobs = allJobs.filter((j) => inWs(j.projectId) && matchesJob(j, q));
  const visibleJobs = wsJobs.filter((j) => inStatus(j, status));
  const inArchive = isArchive(status);
  const hiddenCount = status === "active" ? wsJobs.length - visibleJobs.length : 0;
  // Şerit aramadan bağımsız: yazarken istatistik oynamasın, yalnız workspace süzer.
  const ribbonJobs = allJobs.filter((j) => inWs(j.projectId));

  const allIssues: IssueRow[] = useMemo(
    () =>
      (issues.data?.projects ?? []).flatMap((p) =>
        p.repo ? p.issues.map((i) => ({ ...i, projectId: p.projectId, projectName: p.projectName, repo: p.repo! })) : [],
      ),
    [issues.data],
  );
  const wsIssues = allIssues.filter((i) => inWs(i.projectId) && matchesIssue(i, q));
  const visibleIssues = wsIssues.filter((i) => issueMatches(i, issueFilter));
  const issueErrors = (issues.data?.projects ?? []).filter((p) => p.error && inWs(p.projectId));
  const noRepo = (issues.data?.projects ?? []).filter((p) => !p.repo && !p.error && inWs(p.projectId));

  const selIssue = sel ? allIssues.find((i) => i.projectId === sel.projectId && i.number === sel.number) ?? null : null;
  const issueDetail = useQuery({
    queryKey: ["github-issue", sel?.projectId, sel?.number],
    queryFn: () => api.githubIssue(sel!.projectId, sel!.number),
    enabled: panel === "issue" && sel !== null,
  });
  const selKey = sel ? `${sel.projectId}#${sel.number}` : "";
  useEffect(() => {
    const d = issueDetail.data;
    if (!d || !sel || issueDraft?.key === selKey) return;
    setIssueDraft({
      key: selKey,
      title: d.title,
      // Yalnız gövde: yorumlar çoğu zaman tartışma/gürültüdür ve Planner'ı
      // asıl istekten saptırır. Gerekirse insan açıklamaya elle ekler.
      description: d.body,
      relatedFiles: [],
      referencePaths: [],
      attachments: [],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueDetail.data, selKey]);

  // Hedef: seçilmemişse filtredeki workspace, o da yoksa ilk onaylı profilli.
  const lockTarget = panel === "issue" && sel !== null;
  const targetId = lockTarget
    ? sel.projectId
    : target ?? (ws !== "all" ? ws : projectList.find((p) => p.activeProfileId)?.id ?? projectList[0]?.id ?? null);
  const targetProject = projectList.find((p) => p.id === targetId) ?? null;

  const activeDraft: Draft = lockTarget ? (issueDraft?.key === selKey ? issueDraft : EMPTY_DRAFT) : draft;
  const setActiveDraft = (patch: Partial<Draft>) => {
    if (lockTarget) setIssueDraft((d) => (d ? { ...d, ...patch } : d));
    else setDraft((d) => ({ ...d, ...patch }));
  };

  // Sunucunun kuralı: iptal edilmemiş her iş (Done dahil) issue'yu tutar.
  const linkedActive = lockTarget && selIssue?.linkedJob && selIssue.linkedJob.state !== "Cancelled" ? selIssue.linkedJob : null;
  const criteria = buildCriteria({
    project: targetProject,
    drift: targetProject ? driftOf.get(targetProject.id) ?? null : null,
    driftLoading: Boolean(targetProject?.activeProfileId) && !driftOf.has(targetProject?.id ?? ""),
    system: system.data ?? null,
    issueMode: lockTarget,
    issueNumber: sel?.number ?? null,
    linkedActive: Boolean(linkedActive),
    hasTitle: activeDraft.title.trim().length > 0,
  });
  const blocked = criteria.some((c) => c.tone === "err");
  const warned = criteria.some((c) => c.tone === "wait");
  const nErr = criteria.filter((c) => c.tone === "err").length;

  const create = useMutation({
    mutationFn: async () => {
      const d = activeDraft;
      const description = withRelatedFiles(d.description, d.relatedFiles);
      const job = await api.createJob({
        projectId: targetId!,
        title: d.title.trim(),
        description,
        targetRepos: [],
        referencePaths: d.referencePaths,
        priority: 0,
        attachmentIds: d.attachments.map((a) => a.id),
        ...(lockTarget
          ? {
              source: "github_issue",
              externalRef: `#${sel.number}`,
              ...(selIssue?.url ? { externalUrl: selIssue.url } : {}),
            }
          : { source: "ui" }),
      });
      // Başlatma düşerse iş Draft kalır; detay ekranında "Başlat" düğmesi var.
      // İşi açıp hiç göstermemek daha kötü olurdu — hata bildirimle söylenir.
      const startError = await api.startJob(job.id).then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      return { job, startError };
    },
    onSuccess: ({ job, startError }) => {
      toast(
        startError
          ? { tone: "err", title: "İş açıldı, planlama başlatılamadı", detail: `${job.title} — ${startError}` }
          : { tone: "ok", title: "İş açıldı, planlama başladı", detail: job.title },
      );
      if (lockTarget) setIssueDraft(null);
      else setDraft(EMPTY_DRAFT);
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["github-issues-all"] });
      void navigate(`/jobs/${job.id}`);
    },
  });

  const start = useMutation({
    mutationFn: (id: string) => api.startJob(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["jobs"] }),
  });

  const wsCount = (id: string) =>
    tab === "jobs" ? allJobs.filter((j) => j.projectId === id).length : allIssues.filter((i) => i.projectId === id).length;

  const pickIssue = (i: IssueRow) => {
    setSel({ projectId: i.projectId, number: i.number });
    setPanel("issue");
  };
  const showNew = () => {
    setPanel("new");
    if (ws !== "all") setTarget(ws);
  };

  return (
    <div className="h-full overflow-auto lg:overflow-hidden">
      <div className="grid min-h-full grid-cols-1 lg:h-full lg:grid-cols-[250px_minmax(0,1fr)_420px]">
        {/* ── Sol: workspace + durum filtresi ─────────────────────────────── */}
        <aside className="flex min-w-0 flex-col gap-[18px] overflow-auto border-b border-edge bg-raised px-3.5 pt-4 pb-6 lg:border-r lg:border-b-0">
          <div className="flex flex-col gap-1.5">
            <SideTitle>Workspace</SideTitle>
            <WsFilter
              name="Tüm workspace'ler"
              sub={`${projectList.length} bağlı`}
              subTone="muted"
              count={tab === "jobs" ? allJobs.length : allIssues.length}
              on={ws === "all"}
              onPick={() => setFilter({ ws: "all" })}
            />
            {projectList.map((p) => {
              const w = wsSub(p, driftOf.get(p.id));
              return (
                <WsFilter
                  key={p.id}
                  name={p.name}
                  sub={w.sub}
                  subTone={w.tone}
                  count={wsCount(p.id)}
                  on={ws === p.id}
                  onPick={() => {
                    setFilter({ ws: p.id });
                    if (p.activeProfileId && !lockTarget) setTarget(p.id);
                  }}
                />
              );
            })}
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <SideTitle>{tab !== "jobs" ? "Issue filtresi" : inArchive ? "Arşiv" : "Durum"}</SideTitle>
              <div className="flex-1" />
              {tab === "jobs" && inArchive && (
                <button
                  type="button"
                  onClick={() => setStatus("active")}
                  className="px-1 pb-1 text-[11.5px] font-semibold text-brand-ink hover:underline"
                >
                  ← Aktif işler
                </button>
              )}
            </div>
            {tab === "jobs"
              ? (inArchive ? ARCHIVE_GROUPS : STATUS_GROUPS).map(([id, label, tone]) => (
                  <SideFilter
                    key={id}
                    label={label}
                    tone={tone}
                    count={wsJobs.filter((j) => inStatus(j, id)).length}
                    on={status === id}
                    onPick={() => setStatus(id)}
                  />
                ))
              : ISSUE_FILTERS.map(([id, label, tone]) => (
                  <SideFilter
                    key={id}
                    label={label}
                    tone={tone}
                    count={wsIssues.filter((i) => issueMatches(i, id)).length}
                    on={issueFilter === id}
                    onPick={() => setIssueFilter(id)}
                  />
                ))}
          </div>
        </aside>

        {/* ── Orta: liste ─────────────────────────────────────────────────── */}
        <section className="flex min-h-0 min-w-0 flex-col border-b border-edge bg-surface lg:border-r lg:border-b-0">
          <StatsRibbon
            jobs={ribbonJobs}
            selected={tab === "jobs" ? status : null}
            onPick={(id) => {
              setStatus(id);
              if (tab !== "jobs") setFilter({ tab: "jobs" });
            }}
          />
          <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-edge px-[18px]">
            <TabButton on={tab === "jobs"} count={wsJobs.length} onClick={() => setFilter({ tab: "jobs" })}>
              İşler
            </TabButton>
            <TabButton on={tab === "issues"} count={wsIssues.length} onClick={() => setFilter({ tab: "issues" })}>
              GitHub issue'ları
            </TabButton>
            <div className="flex-1" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Ara: başlık, dal, #numara"
              className="my-2 w-[200px] rounded-[9px] border border-edge bg-surface px-[11px] py-[5px] text-[12.5px] text-ink placeholder:text-ink-dim focus:border-brand focus:outline-none"
            />
            <button
              type="button"
              onClick={showNew}
              className="ml-2 h-[30px] rounded-[9px] border border-transparent bg-brand px-3 text-[12px] font-semibold text-white hover:bg-brand-ink"
            >
              + Yeni iş
            </button>
          </div>

          <div className="flex shrink-0 items-center gap-2.5 border-b border-edge bg-raised px-[18px] py-[9px] font-mono text-[11px] text-ink-muted">
            <span>
              {ws === "all" ? "tüm workspace'ler" : nameOf(ws)} ·{" "}
              {tab === "jobs"
                ? `${visibleJobs.length} iş · ${[...STATUS_GROUPS, ...ARCHIVE_GROUPS].find(([id]) => id === status)?.[1].toLocaleLowerCase("tr") ?? ""}`
                : `${visibleIssues.length} issue`}
            </span>
            <div className="flex-1" />
            {tab === "jobs" ? (
              <span>5 sn'de bir yenilenir</span>
            ) : (
              <span className="flex items-center gap-2">
                {issues.isFetching
                  ? "gh issue list · çekiliyor…"
                  : issues.data
                    ? `gh issue list · ${fmtClock(issues.data.fetchedAt).slice(0, 5)} çekildi`
                    : ""}
                <button
                  type="button"
                  onClick={() => void issues.refetch()}
                  disabled={issues.isFetching}
                  className="rounded-md border border-edge-control bg-surface px-2 py-px text-ink-body hover:bg-sunken disabled:opacity-40"
                >
                  Yenile
                </button>
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {tab === "jobs" && (
              <>
                <ErrorText error={jobs.error} />
                <ErrorText error={start.error} />
                {visibleJobs.map((j) => (
                  <JobRow
                    key={j.id}
                    job={j}
                    projectName={nameOf(j.projectId)}
                    starting={start.isPending && start.variables === j.id}
                    onStart={() => start.mutate(j.id)}
                  />
                ))}
                {jobs.data && visibleJobs.length === 0 && (
                  <EmptyRow title="Bu filtrede iş yok">
                    {ws !== "all" && !projectList.find((p) => p.id === ws)?.activeProfileId
                      ? `${nameOf(ws)} için onaylı profil yok — analiz edip profili onaylayınca iş açılabilir.`
                      : "Başka bir durum ya da workspace seç."}
                  </EmptyRow>
                )}
                {hiddenCount > 0 && (
                  <div className="flex items-center gap-2.5 px-[18px] py-3 text-[12.5px] text-ink-dim">
                    <span>{hiddenCount} bitmiş / iptal iş arşivde</span>
                    <button type="button" onClick={() => setStatus("archive")} className="font-semibold text-brand-ink hover:underline">
                      Arşivi aç
                    </button>
                  </div>
                )}
              </>
            )}

            {tab === "issues" && (
              <>
                <ErrorText error={issues.error} />
                {issueErrors.map((p) => (
                  <div key={p.projectId} className="border-b border-edge bg-err-tint px-[18px] py-2.5 font-mono text-[11px] text-err-body">
                    {p.projectName}: GitHub issue'ları alınamadı — {p.error}
                  </div>
                ))}
                {issues.isLoading && <EmptyRow title="Issue'lar çekiliyor…">Her workspace için gh issue list koşuyor.</EmptyRow>}
                {visibleIssues.map((i) => (
                  <IssueRowView
                    key={`${i.projectId}#${i.number}`}
                    issue={i}
                    on={panel === "issue" && sel?.projectId === i.projectId && sel.number === i.number}
                    onPick={() => pickIssue(i)}
                  />
                ))}
                {issues.data && visibleIssues.length === 0 && (
                  <EmptyRow title="Bu filtrede issue yok">Başka bir filtre ya da workspace seç.</EmptyRow>
                )}
                {noRepo.length > 0 && (
                  <div className="px-[18px] py-3 font-mono text-[11px] text-ink-muted">
                    GitHub reposu çözülemeyen workspace: {noRepo.map((p) => p.projectName).join(", ")} — remote'u yok ya da GitHub değil.
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {/* ── Sağ: iş açma paneli ─────────────────────────────────────────── */}
        <section className="flex min-h-0 min-w-0 flex-col bg-raised">
          <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto px-[18px] pt-4 pb-[18px]">
            {lockTarget ? (
              <IssuePanel
                issue={selIssue}
                repo={selIssue?.repo ?? ""}
                number={sel.number}
                body={issueDetail.data?.body ?? null}
                loading={issueDetail.isLoading}
                error={issueDetail.error}
                draft={activeDraft}
                ready={issueDraft?.key === selKey}
                onDraft={setActiveDraft}
                onNew={showNew}
              />
            ) : (
              <NewPanel draft={activeDraft} onDraft={setActiveDraft} />
            )}

            <div className="flex shrink-0 flex-col gap-[7px]">
              <FieldTitle>Hedef workspace</FieldTitle>
              <div className="flex flex-col gap-[5px]">
                {projectList
                  .filter((p) => !lockTarget || p.id === targetId)
                  .map((p) => (
                    <TargetRow
                      key={p.id}
                      project={p}
                      drift={driftOf.get(p.id) ?? null}
                      on={p.id === targetId}
                      onPick={() => {
                        if (!lockTarget) setTarget(p.id);
                      }}
                    />
                  ))}
                {projectList.length === 0 && (
                  <p className="text-[12.5px] text-ink-muted">
                    Bağlı workspace yok. <Link to="/">Projeler</Link> ekranından bir workspace bağla.
                  </p>
                )}
              </div>
            </div>

            <div
              className={`shrink-0 overflow-hidden rounded-xl border bg-surface ${
                blocked ? "border-err/40" : warned ? "border-wait/40" : "border-ok/40"
              }`}
            >
              <div
                className={`flex items-center gap-2 border-b border-edge px-[13px] py-2.5 ${
                  blocked ? "bg-err-tint" : warned ? "bg-wait-tint" : "bg-brand-tint"
                }`}
              >
                <Dot tone={blocked ? "err" : warned ? "wait" : "ok"} size={8} />
                <span className="text-[12.5px] font-semibold text-ink">İş açma kriterleri</span>
                <div className="flex-1" />
                <span
                  className={`font-mono text-[10.5px] ${blocked ? "text-err-ink" : warned ? "text-wait-ink" : "text-ok-ink"}`}
                >
                  {blocked ? `${nErr} engel` : warned ? "açılabilir · uyarı var" : "hepsi karşılandı"}
                </span>
              </div>
              <div className="flex flex-col gap-2 px-[13px] py-2.5">
                {criteria.map((c) => (
                  <div key={c.label} className="flex items-start gap-[9px]">
                    <span className={`w-4 shrink-0 text-center font-mono text-[11.5px] font-semibold ${TONE_INK[c.tone]}`}>
                      {c.mark}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-px">
                      <span className="text-[12.5px] font-medium text-ink">{c.label}</span>
                      <span className={`text-[11.5px] leading-[1.45] ${c.tone === "ok" || c.tone === "off" ? "text-ink-dim" : TONE_INK[c.tone]}`}>
                        {c.detail}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <ErrorText error={create.error} />
          </div>

          <div className="flex shrink-0 items-center gap-2.5 border-t border-edge bg-surface px-[18px] py-3">
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-muted">
              {lockTarget
                ? `POST /api/jobs · source: github_issue · #${sel.number}`
                : `POST /api/jobs · source: ui · ${targetProject?.name ?? "—"}`}
            </span>
            {linkedActive ? (
              <Link
                to={`/jobs/${linkedActive.id}`}
                className="flex h-9 shrink-0 items-center rounded-[9px] border border-transparent bg-brand px-4 text-[13px] font-semibold text-white no-underline hover:bg-brand-ink hover:text-white hover:no-underline"
              >
                Mevcut işe git →
              </Link>
            ) : (
              <button
                type="button"
                disabled={blocked || create.isPending}
                onClick={() => create.mutate()}
                className="h-9 shrink-0 rounded-[9px] border border-transparent bg-brand px-4 text-[13px] font-semibold text-white hover:bg-brand-ink disabled:cursor-not-allowed disabled:bg-edge disabled:text-ink-dim"
              >
                {create.isPending ? "açılıyor…" : blocked ? "İş açılamaz" : "İş aç ve planlamayı başlat"}
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

// ── Sınıflandırma ────────────────────────────────────────────────────────────

const STATUS_GROUPS: [StatusGroup, string, Tone][] = [
  ["active", "Aktif", "ok"],
  ["wait", "Seni bekleyen", "wait"],
  ["run", "Koşan", "run"],
  ["err", "Kırık", "err"],
];

const ARCHIVE_GROUPS: [StatusGroup, string, Tone][] = [
  ["archive", "Tüm arşiv", "off"],
  ["done", "Bitmiş", "ok"],
  ["cancel", "İptal", "off"],
];

function isArchive(s: StatusGroup): boolean {
  return s === "archive" || s === "done" || s === "cancel";
}

function inStatus(j: Job, s: StatusGroup): boolean {
  const g = groupOf(j);
  if (s === "active") return g !== "done";
  if (s === "archive") return g === "done";
  if (s === "done") return j.state === "Done";
  if (s === "cancel") return j.state === "Cancelled";
  return g === s;
}

const ISSUE_FILTERS: [IssueFilter, string, Tone][] = [
  ["open", "Açık", "ok"],
  ["free", "İşi olmayan", "off"],
  ["linked", "İş açılmış", "run"],
  ["brand", `Etiket: ${BRAND.slug}`, "ok"],
];

const TONE_INK: Record<Tone, string> = {
  ok: "text-ok-ink",
  wait: "text-wait-ink",
  err: "text-err-ink",
  run: "text-run-ink",
  off: "text-off-ink",
};


function statusText(j: Job): string {
  const g = groupOf(j);
  if (g === "err") return firstLine(j.errorMessage) ?? j.errorCode ?? "dikkat gerekiyor";
  if (j.state === "Draft") return "Taslak · başlatılmadı";
  if (isGateState(j.state)) return gateLabel(j.state);
  if (j.phase === "waiting") return `${j.state} · cevap bekliyor`;
  if (j.state === "Done") return "Tamamlandı";
  if (j.state === "Cancelled") return "İptal edildi";
  return `${j.state} · ${j.phase === "starting" ? "başlıyor" : "koşuyor"}`;
}

function firstLine(s: string | null): string | null {
  const l = s?.split("\n").find((x) => x.trim());
  return l ? l.trim() : null;
}

/** Satırdaki eylem: kapı durumunda neyin bekleneceğini söyler, yoksa izle/özet. */
function actionOf(j: Job): { label: string; kind: "accent" | "danger" | "neutral" } {
  const g = groupOf(j);
  if (g === "err") return { label: "Hatayı gör →", kind: "danger" };
  if (j.state === "Draft") return { label: "Başlat →", kind: "accent" };
  if (j.state === "PlanReview") return { label: "Planı incele →", kind: "accent" };
  if (j.state === "QACases") return { label: "Vakaları aç →", kind: "accent" };
  if (j.state === "LiveTest") return { label: "Canlı teste git →", kind: "accent" };
  if (j.state === "PRReview") return { label: "PR'ı incele →", kind: "accent" };
  if (j.phase === "waiting") return { label: "Cevapla →", kind: "accent" };
  if (g === "done") return { label: "Özeti aç", kind: "neutral" };
  return { label: "Canlı izle", kind: "neutral" };
}

const ACTION_CLASS = {
  accent: "border-transparent bg-accent text-white hover:bg-accent-ink hover:text-white",
  danger: "border-transparent bg-err text-white hover:bg-err-ink hover:text-white",
  neutral: "border-edge-control bg-surface text-ink-body hover:bg-raised hover:text-ink-body",
};

function matchesJob(j: Job, q: string): boolean {
  if (!q) return true;
  return [j.title, j.branchName ?? "", j.externalRef ?? ""].some((s) => s.toLowerCase().includes(q));
}

function matchesIssue(i: IssueRow, q: string): boolean {
  if (!q) return true;
  return i.title.toLowerCase().includes(q) || `#${i.number}`.includes(q) || String(i.number) === q;
}

function isBrandLabel(l: string): boolean {
  const s = l.toLowerCase();
  return s === BRAND.slug || s.startsWith(`${BRAND.slug}:`);
}

function issueMatches(i: IssueRow, f: IssueFilter): boolean {
  // İptal edilmiş iş issue'yu serbest bırakır: o issue yeniden "işi olmayan"dır.
  const holds = Boolean(i.linkedJob) && i.linkedJob?.state !== "Cancelled";
  if (f === "free") return !holds;
  if (f === "linked") return holds;
  if (f === "brand") return i.labels.some(isBrandLabel);
  return true;
}

function profileTag(p: Project, drift: Drift | undefined | null): { text: string; tone: Tone } {
  if (p.activeProfileVersion === null) return { text: "profil yok", tone: "err" };
  if (drift?.stale) return { text: `profil v${p.activeProfileVersion} · bayat`, tone: "wait" };
  return { text: `profil v${p.activeProfileVersion}`, tone: "ok" };
}

function wsSub(p: Project, drift: Drift | undefined): { sub: string; tone: "muted" | Tone } {
  if (p.workspaceStatus === "pending") return { sub: "klonlanıyor…", tone: "run" };
  if (p.workspaceStatus === "failed") return { sub: "klon başarısız", tone: "err" };
  if (p.activeProfileVersion === null) {
    return p.runningAnalysisId ? { sub: "profil yok · analiz sürüyor", tone: "run" } : { sub: "profil yok", tone: "err" };
  }
  if (drift?.stale) return { sub: `profil v${p.activeProfileVersion} · bayat`, tone: "wait" };
  return { sub: `profil v${p.activeProfileVersion} onaylı`, tone: "muted" };
}

interface Criterion {
  mark: string;
  tone: Tone;
  label: string;
  detail: string;
}

/**
 * Sunucunun iş açarken uyguladığı kurallar + bilinen riskler. `err` isteği
 * engeller (sunucu da reddeder), `wait` uyarıdır — iş açılır.
 */
function buildCriteria(x: {
  project: Project | null;
  drift: Drift | null;
  driftLoading: boolean;
  system: { identities: { total: number; available: number; nextResetAt: string | null }; github: { token: boolean }; jobs: { running: number } } | null;
  issueMode: boolean;
  issueNumber: number | null;
  linkedActive: boolean;
  hasTitle: boolean;
}): Criterion[] {
  const out: Criterion[] = [];
  const ok = (label: string, detail: string) => out.push({ mark: "✓", tone: "ok", label, detail });
  const bad = (label: string, detail: string) => out.push({ mark: "✕", tone: "err", label, detail });
  const warn = (label: string, detail: string) => out.push({ mark: "!", tone: "wait", label, detail });
  const info = (label: string, detail: string) => out.push({ mark: "–", tone: "off", label, detail });

  const p = x.project;
  if (!p) {
    bad("Hedef workspace yok", "Önce bir workspace bağla ya da seç.");
    return out;
  }
  if (p.workspaceStatus !== "ready") {
    bad("Workspace hazır değil", p.workspaceStatus === "pending" ? "Klon sürüyor; bitince iş açılabilir." : "Klon başarısız — proje sayfasından yeniden dene.");
  }
  if (p.activeProfileVersion !== null) ok(`Onaylı profil · v${p.activeProfileVersion}`, "İş bu profilin build/test komutlarıyla koşar.");
  else bad("Onaylı profil yok", "Analiz bitince profili onayla — onaysız profille iş başlamaz.");

  if (p.activeProfileVersion !== null) {
    if (x.driftLoading) info("Profil bayatlığı denetleniyor…", "Workspace son analizle karşılaştırılıyor.");
    else if (!x.drift?.known) info("Bayatlık bilinemiyor", "Profil elle yazılmış ya da analiz imzası yok.");
    else if (x.drift.stale) {
      const n = x.drift.changed.length + x.drift.added.length + x.drift.removed.length;
      warn(`Profil bayat · ${n} dosya değişti`, "İş açılır; yeniden analiz önerilir.");
    } else ok("Profil güncel", "Son analizden beri değişiklik yok.");
  }

  if (x.system) {
    const { total, available, nextResetAt } = x.system.identities;
    if (available > 0) {
      ok(
        `Kimlik havuzu · ${available}/${total} uygun`,
        available < total && nextResetAt ? `Dinlenen kimlik ${fmtClock(nextResetAt).slice(0, 5)}'te döner.` : "Tüm kimlikler kullanılabilir.",
      );
    } else {
      warn(
        `Kimlik havuzu · 0/${total} uygun`,
        nextResetAt ? `İlk kimlik ${fmtClock(nextResetAt).slice(0, 5)}'te döner; agent turu o zamana dek bekler.` : "Uygun kimlik yok.",
      );
    }
    info(`Koşan iş · ${x.system.jobs.running}`, "Eşzamanlı iş sınırı yok; iş hemen başlar.");
    if (!x.system.github.token) {
      warn("GitHub kimliği yok", "Sunucuda GH_TOKEN/gh oturumu yok — push ve PR adımı düşer.");
    }
  }

  if (x.issueMode) {
    if (x.linkedActive) bad("Issue'ya bağlı iş var", `#${x.issueNumber} için tek iş açılır; yalnız iptal edilmiş iş yenisine izin verir — mevcut işe git.`);
    else ok("Issue'ya bağlı iş yok", `#${x.issueNumber} için yeni iş açılabilir.`);
  }
  if (x.hasTitle) ok("Başlık dolu", "Planner başlık ve açıklamadan plan üretir.");
  else bad("Başlık boş", "İşe bir başlık ver.");
  return out;
}

// ── Parçalar ─────────────────────────────────────────────────────────────────

function SideTitle({ children }: { children: ReactNode }) {
  return <span className="px-1 pb-1 font-mono text-[11px] tracking-[.1em] text-ink-muted uppercase">{children}</span>;
}

function FieldTitle({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[10.5px] tracking-[.06em] text-ink-muted uppercase">{children}</span>;
}

function WsFilter({
  name,
  sub,
  subTone,
  count,
  on,
  onPick,
}: {
  name: string;
  sub: string;
  subTone: "muted" | Tone;
  count: number;
  on: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={`flex flex-col gap-[3px] rounded-[10px] border px-[11px] py-[9px] text-left ${
        on ? "border-brand-edge bg-brand-tint" : "border-transparent hover:bg-sunken"
      }`}
    >
      <span className="flex w-full items-center gap-2">
        <span className={`min-w-0 flex-1 truncate text-[13px] font-semibold ${on ? "text-brand-ink" : "text-ink"}`}>{name}</span>
        <span className="font-mono text-[11px] text-ink-muted">{count}</span>
      </span>
      <span className={`font-mono text-[10.5px] ${subTone === "muted" ? "text-ink-muted" : TONE_INK[subTone]}`}>{sub}</span>
    </button>
  );
}

function SideFilter({ label, tone, count, on, onPick }: { label: string; tone: Tone; count: number; on: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={`flex items-center gap-2 rounded-[9px] px-[11px] py-[7px] text-left text-[12.5px] ${
        on ? "bg-brand-tint font-semibold text-brand-ink" : "text-ink-body hover:bg-sunken"
      }`}
    >
      <Dot tone={tone} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="font-mono text-[11px] font-normal text-ink-muted">{count}</span>
    </button>
  );
}

function TabButton({ on, count, onClick, children }: { on: boolean; count: number; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-[7px] border-b-2 px-3 py-3 text-[13px] font-semibold ${
        on ? "border-brand text-brand-ink" : "border-transparent text-ink-soft hover:text-ink"
      }`}
    >
      {children}
      <span className="rounded-[5px] bg-chip px-1.5 py-px font-mono text-[10.5px] text-off-ink">{count}</span>
    </button>
  );
}

// Tailwind sınıfları derleme anında taranır; tonla birleştirilen dize üretilemez.
const RIBBON_MARK: Record<Tone, string> = {
  ok: "shadow-[inset_0_-2px_0_var(--color-brand)]",
  wait: "shadow-[inset_0_-2px_0_var(--color-wait)]",
  run: "shadow-[inset_0_-2px_0_var(--color-run)]",
  err: "shadow-[inset_0_-2px_0_var(--color-err)]",
  off: "shadow-[inset_0_-2px_0_var(--color-ink-faint)]",
};

/**
 * İstatistik şeridi — workspace filtresine göre sayılar; bir hücre o durum
 * filtresini açar. Maliyet hücresi yalnız bilgidir. Alt satır `title`da:
 * görünür yapmak şeridi iki katına çıkarıyordu.
 */
function StatsRibbon({
  jobs,
  selected,
  onPick,
}: {
  jobs: Job[];
  selected: StatusGroup | null;
  onPick: (id: StatusGroup) => void;
}) {
  const n = (s: StatusGroup) => jobs.filter((j) => inStatus(j, s)).length;
  const waiting = jobs.filter((j) => inStatus(j, "wait"));
  const oldestWait = waiting.reduce<string | null>((min, j) => (min === null || j.updatedAt < min ? j.updatedAt : min), null);
  const cost = jobs.reduce((sum, j) => sum + j.costMicroUsd, 0);
  const paid = jobs.filter((j) => j.costMicroUsd > 0).length;

  const cells: { id: StatusGroup | null; label: string; value: string; sub: string; tone: Tone }[] = [
    { id: "active", label: "Aktif iş", value: String(n("active")), sub: "bitmemiş ve iptal edilmemiş", tone: "ok" },
    { id: "wait", label: "Seni bekleyen", value: String(waiting.length), sub: oldestWait ? `en eskisi ${fmtAge(oldestWait)}` : "yok", tone: "wait" },
    { id: "run", label: "Koşan", value: String(n("run")), sub: "agent şu an çalışıyor", tone: "run" },
    { id: "err", label: "Kırık", value: String(n("err")), sub: n("err") ? "müdahale gerekli" : "yok", tone: "err" },
    { id: "archive", label: "Arşiv", value: String(n("archive")), sub: `${n("done")} bitmiş · ${n("cancel")} iptal`, tone: "off" },
    { id: null, label: "Maliyet", value: fmtUsd(cost), sub: paid ? `ort. iş ${fmtUsd(Math.round(cost / paid))}` : "henüz harcama yok", tone: "off" },
  ];

  return (
    <div className="grid shrink-0 grid-cols-3 border-b border-edge bg-surface sm:grid-cols-6">
      {cells.map((c) => {
        const on = c.id !== null && selected !== null && (selected === c.id || (c.id === "archive" && isArchive(selected)));
        const body = (
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <Dot tone={c.tone} size={6} />
              <span className="min-w-0 truncate font-mono text-[10px] tracking-[.06em] text-ink-muted uppercase">{c.label}</span>
            </span>
            <span className={`text-[19px] leading-[1.15] font-semibold tracking-[-.02em] ${c.id === null ? "text-ink-body" : TONE_INK[c.tone]}`}>
              {c.value}
            </span>
          </>
        );
        const cls = `flex min-w-0 flex-col gap-[3px] border-r border-edge px-3 pt-2.5 pb-[11px] text-left ${
          on ? `bg-raised ${RIBBON_MARK[c.tone]}` : "bg-surface"
        }`;
        return c.id === null ? (
          <div key={c.label} title={c.sub} className={cls}>
            {body}
          </div>
        ) : (
          <button key={c.label} type="button" title={c.sub} onClick={() => onPick(c.id!)} className={`${cls} hover:bg-raised`}>
            {body}
          </button>
        );
      })}
    </div>
  );
}

function EmptyRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-[18px] py-10 text-center">
      <span className="text-[14px] font-semibold text-ink">{title}</span>
      <span className="text-[12.5px] text-ink-dim">{children}</span>
    </div>
  );
}

function JobRow({ job: j, projectName, starting, onStart }: { job: Job; projectName: string; starting: boolean; onStart: () => void }) {
  const tone = jobTone(j.state, j.phase);
  const action = actionOf(j);
  const meta = [
    projectName,
    j.branchName ?? "dal yok",
    j.externalRef ?? `kaynak: ${j.source}`,
    j.profileVersion !== null ? `profil v${j.profileVersion}` : null,
    j.costMicroUsd > 0 ? fmtUsd(j.costMicroUsd) : null,
  ].filter(Boolean).join(" · ");
  const btn = `flex h-[30px] w-[118px] shrink-0 items-center justify-center rounded-[9px] border text-[12px] font-semibold no-underline hover:no-underline ${ACTION_CLASS[action.kind]}`;

  return (
    <div className="flex flex-wrap items-center gap-x-[13px] gap-y-2 border-b border-edge px-[18px] py-[13px] hover:bg-raised sm:flex-nowrap">
      <Dot tone={tone} pulse={tone === "run"} />
      <Link to={`/jobs/${j.id}`} className="flex min-w-0 flex-1 flex-col gap-1 no-underline hover:no-underline">
        <span className="truncate text-[13.5px] font-semibold text-ink">{j.title}</span>
        <span className="truncate font-mono text-[11px] text-ink-muted">{meta}</span>
      </Link>
      <span className={`hidden w-[190px] shrink-0 truncate text-[12.5px] md:inline ${TONE_INK[tone]}`} title={statusText(j)}>
        {statusText(j)}
      </span>
      <span className="hidden w-[118px] shrink-0 sm:flex">
        <span className={`rounded-md border px-2 py-[3px] font-mono text-[10.5px] font-medium ${BADGE[tone]}`}>{j.state}</span>
      </span>
      <span className="w-11 shrink-0 text-right font-mono text-[11px] text-ink-muted">{fmtAge(j.updatedAt)}</span>
      {j.state === "Draft" ? (
        <button type="button" disabled={starting} onClick={onStart} className={`${btn} disabled:opacity-50`}>
          {starting ? "başlıyor…" : action.label}
        </button>
      ) : (
        <Link to={`/jobs/${j.id}`} className={btn}>
          {action.label}
        </Link>
      )}
    </div>
  );
}

const BADGE: Record<Tone, string> = {
  run: "bg-run/12 text-run-ink border-run/40",
  wait: "bg-wait/12 text-wait-ink border-wait/40",
  ok: "bg-ok/12 text-ok-ink border-ok/40",
  err: "bg-err/12 text-err-ink border-err/40",
  off: "bg-off/12 text-off-ink border-off/40",
};

/** Bilinen etiketlerin rengi; gerisi nötr çip. */
function labelClass(l: string): string {
  const s = l.toLowerCase();
  if (s === "bug" || s.includes("hata")) return "border-err-edge bg-err-tint text-err-ink";
  if (s === "feature" || s === "enhancement") return "border-accent-edge bg-accent-tint text-accent-ink";
  if (isBrandLabel(l)) return "border-brand-edge bg-brand-tint text-brand-ink";
  return "border-edge bg-chip text-off-ink";
}

function linkedText(state: string): { text: string; tone: Tone } {
  if (state === "Done") return { text: "iş bitti", tone: "ok" };
  if (state === "Cancelled") return { text: "iş iptal edildi", tone: "off" };
  if (state === "NeedsAttention") return { text: "iş kırık", tone: "err" };
  if (state === "Draft") return { text: "iş açık · taslak", tone: "wait" };
  if (isGateState(state as Job["state"])) return { text: `iş açık · ${gateLabel(state as Job["state"]).toLowerCase()}`, tone: "wait" };
  return { text: "iş koşuyor", tone: "run" };
}

function IssueRowView({ issue: i, on, onPick }: { issue: IssueRow; on: boolean; onPick: () => void }) {
  const link = i.linkedJob ? linkedText(i.linkedJob.state) : null;
  // Satır bir düğme; iş linki onun İÇİNE konamaz (iç içe etkileşimli öğe) —
  // bağlı iş varsa durum sütunu düğmenin kardeşi olan bir link olur.
  return (
    <div
      className={`flex w-full border-b border-edge ${
        on ? "bg-raised shadow-[inset_3px_0_0_var(--color-brand)]" : "bg-surface hover:bg-raised"
      }`}
    >
      <button
        type="button"
        onClick={onPick}
        className={`flex min-w-0 flex-1 gap-3 py-[13px] pl-[18px] text-left ${i.linkedJob ? "" : "pr-[18px]"}`}
      >
        <span className="w-[46px] shrink-0 font-mono text-[12px] text-ink-muted">#{i.number}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-[13.5px] font-semibold text-ink">{i.title}</span>
          <span className="flex flex-wrap items-center gap-[7px]">
            <span className="rounded-[5px] border border-edge bg-chip px-[7px] py-[2px] font-mono text-[10.5px] text-ink-body">
              {i.projectName}
            </span>
            {i.labels.map((l) => (
              <span key={l} className={`rounded-[5px] border px-[7px] py-[2px] font-mono text-[10.5px] ${labelClass(l)}`}>
                {l}
              </span>
            ))}
            <span className="font-mono text-[10.5px] text-ink-muted">
              {i.author} · {fmtAge(i.updatedAt)} · {i.comments} yorum
            </span>
          </span>
        </span>
        {!link && (
          <span className="hidden w-[150px] shrink-0 items-center gap-[7px] text-[12.5px] text-ink-dim sm:flex">
            <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-edge-strong" />
            <span className="truncate">bağlı iş yok</span>
          </span>
        )}
      </button>
      {i.linkedJob && link && (
        <Link
          to={`/jobs/${i.linkedJob.id}`}
          title="İş detayına git"
          className={`hidden w-[180px] shrink-0 items-center gap-[7px] py-[13px] pr-[18px] pl-3 text-[12.5px] no-underline hover:underline sm:flex ${TONE_INK[link.tone]}`}
        >
          <Dot tone={link.tone} />
          <span className="truncate">{link.text}</span>
          <span className="shrink-0">→</span>
        </Link>
      )}
    </div>
  );
}

function IssuePanel({
  issue,
  repo,
  number,
  body,
  loading,
  error,
  draft,
  ready,
  onDraft,
  onNew,
}: {
  issue: IssueRow | null;
  repo: string;
  number: number;
  body: string | null;
  loading: boolean;
  error: unknown;
  draft: Draft;
  ready: boolean;
  onDraft: (patch: Partial<Draft>) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-3">
      <div className="flex items-center gap-[9px]">
        <span className="font-mono text-[12px] text-ink-muted">
          #{number} · {repo}
        </span>
        <div className="flex-1" />
        {issue?.url && (
          <a href={issue.url} target="_blank" rel="noreferrer" className="text-[12px]">
            GitHub'da aç ↗
          </a>
        )}
      </div>
      <span className="text-[17px] leading-[1.35] font-semibold tracking-[-.01em] text-pretty text-ink">
        {issue?.title ?? `#${number}`}
      </span>
      {issue?.linkedJob && (
        <Link
          to={`/jobs/${issue.linkedJob.id}`}
          className={`flex items-center gap-[7px] self-start text-[12.5px] ${TONE_INK[linkedText(issue.linkedJob.state).tone]}`}
        >
          <Dot tone={linkedText(issue.linkedJob.state).tone} />
          Bağlı iş · {linkedText(issue.linkedJob.state).text} — detaya git →
        </Link>
      )}
      <ErrorText error={error} />
      <div className="aht-wrap max-h-72 overflow-auto rounded-xl border border-edge bg-surface px-3.5 py-3 text-[13px] leading-[1.65] text-ink-body">
        {loading ? "issue okunuyor…" : body ? <Markdown baseUrl={issue?.url}>{body}</Markdown> : "(gövde boş)"}
      </div>
      <div className="flex items-start gap-2 text-[12.5px] text-ink-body">
        <span className="font-mono text-[11px] text-brand-ink">✓</span>
        <span>
          PR gövdesine <span className="font-mono text-[11.5px]">Closes #{number}</span> eklenir · issue'ya iş linki yorum düşülür
        </span>
      </div>
      {ready && <DraftFields draft={draft} onDraft={onDraft} descLabel="Açıklama · issue gövdesi (markdown)" />}
      <button type="button" onClick={onNew} className="self-start text-[12px] text-ink-muted hover:text-ink">
        Issue'suz yeni iş aç →
      </button>
    </div>
  );
}

function NewPanel({ draft, onDraft }: { draft: Draft; onDraft: (patch: Partial<Draft>) => void }) {
  return (
    <div className="flex shrink-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-[17px] font-semibold tracking-[-.01em] text-ink">Yeni iş aç</span>
        <span className="text-[12.5px] leading-[1.55] text-ink-soft">
          Issue olmadan açılır (<span className="font-mono text-[11.5px]">kaynak: ui</span>). Dosya yolları ve görseller
          Planner'ın ilk bağlamı olur.
        </span>
      </div>
      <DraftFields draft={draft} onDraft={onDraft} descLabel="Açıklama" />
    </div>
  );
}

function DraftFields({ draft, onDraft, descLabel }: { draft: Draft; onDraft: (patch: Partial<Draft>) => void; descLabel: string }) {
  return (
    <>
      <label className="flex flex-col gap-[5px]">
        <FieldTitle>Başlık</FieldTitle>
        <input className={`${inputClass} text-[13px]`} value={draft.title} onChange={(e) => onDraft({ title: e.target.value })} />
      </label>
      <label className="flex flex-col gap-[5px]">
        <FieldTitle>{descLabel}</FieldTitle>
        <textarea
          className={`${inputClass} h-24 text-[12.5px] leading-[1.6]`}
          value={draft.description}
          onChange={(e) => onDraft({ description: e.target.value })}
          placeholder="Ne yapılacak? Planner bu metinden plan üretir."
        />
      </label>
      <ExtrasFields
        relatedFiles={draft.relatedFiles}
        onRelatedFilesChange={(relatedFiles) => onDraft({ relatedFiles })}
        referencePaths={draft.referencePaths}
        onReferencePathsChange={(referencePaths) => onDraft({ referencePaths })}
        attachments={draft.attachments}
        onAttachmentsChange={(attachments) => onDraft({ attachments })}
      />
    </>
  );
}

function TargetRow({ project: p, drift, on, onPick }: { project: Project; drift: Drift | null; on: boolean; onPick: () => void }) {
  const tag = profileTag(p, drift);
  return (
    <button
      type="button"
      onClick={onPick}
      className={`flex items-center gap-2.5 rounded-[10px] border bg-surface px-[11px] py-[9px] text-left ${
        on ? "border-brand shadow-[0_0_0_3px_rgba(11,124,99,.10)]" : "border-edge hover:border-edge-control"
      }`}
    >
      <span
        className={`h-3.5 w-3.5 shrink-0 rounded-full border shadow-[inset_0_0_0_3px_#fff] ${
          on ? "border-brand bg-brand" : "border-edge-control bg-surface"
        }`}
      />
      <span className="text-[13px] font-semibold text-ink">{p.name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-muted">{repoName(p)}</span>
      <span className={`shrink-0 font-mono text-[10.5px] ${TONE_INK[tag.tone]}`}>{tag.text}</span>
    </button>
  );
}

function repoName(p: Project): string {
  const m = /[:/]([^/]+?)(?:\.git)?\/?$/.exec(p.sourceGitUrl ?? "");
  return m?.[1] ?? p.slug;
}
