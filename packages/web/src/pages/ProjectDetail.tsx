import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type ProfileFull } from "../api";
import { Badge, Button, Dot, EmptyState, ErrorText, Input, fmtAge, fmtTime, jobTone, type Tone } from "../ui";
import { ProfileDoc } from "../components/ProfileDoc";
import { ProfileEditor } from "../components/ProfileEditor";
import { CodeMapCard } from "../components/CodeMapCard";
import { ReleaseCard } from "../components/ReleaseCard";

/**
 * Aşama 0: analiz et → taslağı incele (belge + gerekçe) → doğrula → onayla.
 *
 * Analiz sürerken durum 2 sn'de bir yoklanır; bitince taslak listede belirir.
 * Doğrulama onayı ENGELLEMEZ — mekanik denetimdir, insan yine de onaylayabilir.
 */
export function ProjectDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const project = useQuery({
    queryKey: ["project", id],
    queryFn: () => api.project(id),
    refetchInterval: (q) => (q.state.data?.workspaceStatus === "pending" ? 2000 : false),
  });
  const profiles = useQuery({ queryKey: ["profiles", id], queryFn: () => api.profiles(id) });
  // Liste ekranıyla aynı key: oradan gelindiyse istek atılmaz.
  const versions = useQuery({ queryKey: ["project-versions"], queryFn: api.projectVersions, staleTime: 5 * 60_000, retry: false });
  const version = versions.data?.[id] ?? null;
  const runningId = project.data?.runningAnalysisId ?? null;
  const analysis = useQuery({
    queryKey: ["analysis", runningId],
    queryFn: () => api.analysis(runningId!),
    enabled: Boolean(runningId),
    refetchInterval: (q) => (q.state.data?.status === "running" ? 2000 : false),
  });
  const drift = useQuery({ queryKey: ["drift", id], queryFn: () => api.drift(id), enabled: false });
  const [picked, setSelected] = useState<string | null>(null);
  // İnsan bir sürüm seçmediyse onaylı profil açılır. Effect'le state'e yazmak
  // yerine türetiliyor: proje sorgusu geç gelse de, silme seçimi sıfırlasa da
  // aynı kural geçerli kalır.
  const selected = picked ?? project.data?.activeProfileId ?? null;
  // `ProfileView`de DEĞİL burada: kaydetmek `setSelected` ile yeni versiyonu
  // seçtiriyor, bu da `profile.data.id` değişince `key={profile.data.id}`
  // yüzünden `ProfileView`i unmount/remount ediyor — state orada olsaydı
  // uyarı hiç görünmeden kaybolurdu (CodeRabbit, remount'tan etkilenmeyen yer).
  const [droppedFields, setDroppedFields] = useState<string[] | null>(null);
  // Onay imaj build'i başlattıysa kimliği burada tutulur (`droppedFields` ile
  // aynı gerekçe: `ProfileView` versiyon değişiminde remount oluyor, state
  // orada olsaydı build izi kaybolurdu).
  //
  // PROFİLE BAĞLI tutulur: yalnız buildId saklamak, v3'ü onaylayıp v2'ye geçen
  // kullanıcıya v3'ün build'ini v2 başlığı altında gösterirdi — "yeniden dene"
  // v2'yi build ederken ekrandaki hata v3'e ait olurdu.
  const [imageBuild, setImageBuild] = useState<{ profileId: string; buildId: string } | null>(null);
  const profile = useQuery({
    queryKey: ["profile", selected],
    queryFn: () => api.profile(selected!),
    enabled: Boolean(selected),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["project", id] });
    void qc.invalidateQueries({ queryKey: ["profiles", id] });
    void qc.invalidateQueries({ queryKey: ["projects"] });
  };
  const analyze = useMutation({ mutationFn: () => api.analyze(id), onSuccess: refresh });
  const retryClone = useMutation({ mutationFn: () => api.retryClone(id), onSuccess: refresh });
  const syncSource = useMutation({ mutationFn: () => api.syncSource(id) });
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: (removeFiles: boolean) => api.deleteProject(id, removeFiles),
    onSuccess: (res) => {
      // Proje satırı artık yok, ekranda kalınamaz: eksik temizlik yönlendirmeden
      // ÖNCE bildirilir, yoksa yarım kalan dosyalar sessizce gözden kaçar.
      if (res.incomplete.length > 0) {
        alert(`Proje silindi ama temizlik yarım kaldı: ${res.incomplete.join(", ")}`);
      }
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.removeQueries({ queryKey: ["project", id] });
      void navigate("/", { replace: true });
    },
  });

  function confirmRemove() {
    if (!p) return;
    if (!confirm(`"${p.name}" silinsin mi? Projeye ait TÜM işler (bitmişler dahil), profiller ve analizler kaldırılır. Geri alınamaz.`)) return;
    // Dosya sorusu ayrı: dışarıdan bağlanan repoda hiç sorulmaz (sunucu da reddeder).
    const removeFiles = p.canRemoveFiles && confirm(`Klonlanan dizin de diskten silinsin mi?\n${p.workspaceRoot}\n\nİptal → dizin yerinde kalır.`);
    remove.mutate(removeFiles);
  }
  const decide = useMutation({
    mutationFn: (v: { decision: "approve" | "reject"; comment?: string }) =>
      api.decideProfile(selected!, v.decision, v.comment),
    onSuccess: (res) => {
      refresh();
      void qc.invalidateQueries({ queryKey: ["profile", selected] });
      // Onay imajı build etmeye başladıysa izlemeye al; etmediyse (imaj zaten
      // vardı ya da ret) eski izi temizle.
      setImageBuild(res.imageBuildId && selected ? { profileId: selected, buildId: res.imageBuildId } : null);
    },
  });

  // Analiz bitince listeyi tazele. Render sırasında setState yapılmaz —
  // React 19'da bu uyarı üretir ve döngüye girebilir.
  const done = analysis.data && analysis.data.status !== "running";
  useEffect(() => {
    if (done && runningId) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, runningId]);

  const p = project.data;

  return (
    <div className="h-full overflow-auto px-6 py-5">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/" className="text-[13px] text-ink-muted no-underline hover:text-ink">
            ← Projeler
          </Link>
          <h1 className="text-[19px] font-semibold tracking-[-.015em] text-ink">{p?.name}</h1>
          <span className="font-mono text-[12px] text-ink-muted">{p?.slug}</span>
          {version?.tag && (
            <span className="font-mono text-[12px] text-ink-soft" title={`${version.repo} — son sürüm tag'i`}>
              {version.tag}
            </span>
          )}
          {p && (
            <Badge
              value={p.activeProfile ? `profil v${p.activeProfile.version} onaylı` : "profil yok"}
              tone={p.activeProfile ? "ok" : "off"}
            />
          )}
          <div className="flex-1" />
          {/* Issue'lar ve iş açma İşler ekranında — workspace filtresi hazır gelir. */}
          <Link
            to={`/jobs?ws=${id}`}
            className="rounded-[9px] border border-edge-control bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-body no-underline hover:bg-raised"
          >
            İşler ve issue'lar →
          </Link>
          <Button
            variant="danger"
            size="sm"
            disabled={!p || remove.isPending || Boolean(runningId) || p.workspaceStatus === "pending"}
            title={runningId || p?.workspaceStatus === "pending" ? "Analiz ya da klon sürerken silinemez" : undefined}
            onClick={confirmRemove}
          >
            {remove.isPending ? "Siliniyor…" : "Workspace'i sil"}
          </Button>
        </div>
        <ErrorText error={project.error} />
        <ErrorText error={remove.error} />

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="flex min-w-0 flex-col gap-4">
            <section
              className={`overflow-hidden rounded-xl border bg-surface ${runningId ? "border-accent-edge" : "border-edge"}`}
            >
              <header
                className={`flex items-center gap-2 border-b border-edge px-[13px] py-2.5 ${runningId ? "bg-accent-tint" : "bg-raised"}`}
              >
                {runningId && <Dot tone="run" pulse />}
                <h2 className="text-[12.5px] font-semibold text-ink">{runningId ? "Analiz koşuyor" : "Analiz"}</h2>
                <div className="flex-1" />
                <Button
                  variant={runningId ? "neutral" : "primary"}
                  size="sm"
                  disabled={analyze.isPending || Boolean(runningId) || p?.workspaceStatus !== "ready"}
                  onClick={() => analyze.mutate()}
                >
                  {runningId ? "sürüyor…" : "Analiz et"}
                </Button>
              </header>
              <div className="flex flex-col gap-2.5 px-[13px] py-[11px]">
                <div className="aht-wrap font-mono text-[11px] text-ink-muted">{p?.workspaceRoot}</div>
                {p?.workspaceStatus === "pending" && (
                  <div className="flex items-center gap-2 font-mono text-[11.5px] text-run-ink">
                    <Dot tone="run" pulse />
                    Workspace klonlanıyor…
                  </div>
                )}
                {p?.workspaceStatus === "failed" && (
                  <div className="flex flex-col gap-2">
                    {/* `whitespace-pre-wrap`: mesaj artık git'in son çıktı
                        satırlarını taşıyor (clone.ts) — düzleşirse okunmaz. */}
                    <div className="aht-wrap whitespace-pre-wrap rounded-lg border border-err-edge bg-err-tint px-3 py-2 font-mono text-[11.5px] text-err-body">
                      {p.workspaceError ?? "klon başarısız"}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={retryClone.isPending}
                      onClick={() => retryClone.mutate()}
                    >
                      Yeniden dene
                    </Button>
                    <ErrorText error={retryClone.error} />
                  </div>
                )}
                {p?.workspaceStatus === "ready" && p.activeProfileId && (
                  <div className="flex flex-col gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={syncSource.isPending}
                      onClick={() => syncSource.mutate()}
                      title="Kaynak workspace'i uzaktaki varsayılan dala ilerletir; yetki sorunlarını (ör. başka kullanıcıya ait FETCH_HEAD) kendisi onarır"
                    >
                      {syncSource.isPending ? "Güncelleniyor…" : "Kaynağı güncelle"}
                    </Button>
                    {syncSource.data?.results.map((r) => (
                      <div
                        key={r.repo}
                        className={`aht-wrap whitespace-pre-wrap rounded-lg border px-3 py-2 font-mono text-[11.5px] ${
                          r.status === "skipped" ? "border-err-edge bg-err-tint text-err-body" : "border-edge bg-raised text-ink-body"
                        }`}
                      >
                        {r.status === "updated" && `${r.repo}: güncellendi ${r.from.slice(0, 8)} → ${r.to.slice(0, 8)}`}
                        {r.status === "current" && `${r.repo}: güncel`}
                        {r.status === "skipped" && `${r.repo}: güncellenemedi\nNerede: host, ${r.dir} (kullanıcı: ${r.user})\nNeden: ${r.reason}`}
                      </div>
                    ))}
                    <ErrorText error={syncSource.error} />
                  </div>
                )}
                {analysis.data?.status === "running" && (
                  <div className="flex items-center gap-2 text-[12.5px] font-medium text-run-ink">
                    <span className="font-mono text-[11px]">→</span>
                    Analyst workspace'i okuyor…
                  </div>
                )}
                {p?.latestAnalysis && (
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] text-ink-body">Son analiz</span>
                    <Badge
                      value={p.latestAnalysis.status}
                      tone={p.latestAnalysis.status === "succeeded" ? "ok" : p.latestAnalysis.status === "failed" ? "err" : "run"}
                    />
                    <span className="ml-auto font-mono text-[10.5px] text-ink-muted">{fmtTime(p.latestAnalysis.createdAt)}</span>
                  </div>
                )}
                {p?.latestAnalysis?.error && (
                  <div className="aht-wrap rounded-lg border border-err-edge bg-err-tint px-3 py-2 font-mono text-[11.5px] text-err-body">
                    {p.latestAnalysis.error}
                  </div>
                )}
                {/* Not HATA DEĞİL: analiz başarılı, yalnız imaj tarafında
                    bilinmesi gereken bir durum var (ör. Dockerfile üretilmedi).
                    Kırmızı kutu bunu olduğundan vahim gösteriyordu. */}
                {p?.latestAnalysis?.note && (
                  <div className="aht-wrap rounded-lg border border-edge bg-raised px-3 py-2 font-mono text-[11.5px] text-ink-muted">
                    {p.latestAnalysis.note}
                  </div>
                )}
                <ErrorText error={analyze.error} />

                <div className="flex flex-col gap-2 border-t border-edge pt-2.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    onClick={() => void drift.refetch()}
                    disabled={!p?.activeProfile}
                  >
                    Bayatlık kontrolü
                  </Button>
                  {drift.data && (
                    <div className="text-[12px]">
                      {!drift.data.known && <span className="text-ink-muted">bilinemiyor (analizsiz profil)</span>}
                      {drift.data.known && !drift.data.stale && <span className="text-brand-ink">profil güncel</span>}
                      {drift.data.stale && (
                        <span className="aht-wrap text-wait-ink">
                          profil bayat: {[...drift.data.changed, ...drift.data.added, ...drift.data.removed].join(", ")}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>

            <div className="flex flex-col gap-2">
              <span className="font-mono text-[11px] uppercase tracking-[.1em] text-ink-muted">Profil sürümleri</span>
              {profiles.data?.length === 0 && (
                <div className="rounded-xl border border-edge bg-surface px-4 py-5 text-center text-[12.5px] text-ink-dim">
                  Henüz profil yok.
                </div>
              )}
              {profiles.data?.map((r) => {
                const active = r.id === p?.activeProfileId;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelected(r.id)}
                    className={`flex flex-col gap-[5px] rounded-xl border px-[13px] py-[11px] text-left transition-colors ${
                      selected === r.id ? "border-brand-edge bg-brand-tint" : "border-edge bg-surface hover:bg-raised"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-[12.5px] font-semibold text-ink">v{r.version}</span>
                      <Badge value={profileStatusLabel(r.status)} tone={profileTone(r.status)} />
                      <span className="flex-1" />
                      <span className="font-mono text-[10.5px] text-ink-muted">{fmtTime(r.createdAt)}</span>
                    </span>
                    {(active || r.analysisId === null) && (
                      <span className="text-[12px] text-ink-dim">
                        {[active ? "aktif" : null, r.analysisId === null ? "elle düzenlendi" : null].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {p?.workspaceStatus === "ready" && <IssueTemplatesCard projectId={id} />}
            {p?.workspaceStatus === "ready" && <ReleaseCard projectId={id} />}
            {p?.workspaceStatus === "ready" && <CodeMapCard projectId={id} />}

            <ProjectJobsList projectId={id} />
          </aside>

          <div className="flex min-w-0 flex-col gap-4">
            {droppedFields && (
              <div className="rounded-xl border border-wait-edge bg-wait-tint px-3 py-2 text-[12.5px] text-wait-ink">
                Şu alanlar tanınmadı ve kaydedilmedi: {droppedFields.join(", ")}
              </div>
            )}

            {profile.data ? (
              // `key`: profil değişince doğrulama sonucu ve red yorumu sıfırlansın.
              // Aksi hâlde A profilinin doğrulaması B seçiliyken ekranda kalır ve
              // operatör yanlış profili onaylar.
              <ProfileView
                key={profile.data.id}
                projectId={id}
                profile={profile.data}
                onDecide={(d, c) => decide.mutate({ decision: d, comment: c })}
                pending={decide.isPending}
                error={decide.error}
                imageBuildId={imageBuild?.profileId === profile.data.id ? imageBuild.buildId : null}
                onImageBuildStarted={(buildId) => setImageBuild({ profileId: profile.data!.id, buildId })}
                onSaved={(row) => {
                  refresh();
                  setSelected(row.id);
                  setDroppedFields(row.droppedFields && row.droppedFields.length > 0 ? row.droppedFields : null);
                }}
                onDeleted={() => {
                  refresh();
                  setSelected(null);
                }}
              />
            ) : (
              <div className="rounded-xl border border-edge bg-surface">
                {profiles.data && profiles.data.length > 0 ? (
                  <EmptyState title="Profil seç">
                    Soldaki listeden bir sürüm seç; belge, gerekçeler ve onay düğmeleri burada açılır.
                  </EmptyState>
                ) : (
                  <EmptyState title="Profil yok">
                    Analiz et — Analyst workspace'i okuyup bir taslak profil yazar; taslak burada incelenip onaylanır.
                  </EmptyState>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function profileTone(status: string): Tone {
  if (status === "approved") return "ok";
  if (status === "rejected") return "err";
  if (status === "draft") return "wait";
  return "off";
}

function profileStatusLabel(status: string): string {
  if (status === "approved") return "onaylı";
  if (status === "rejected") return "reddedildi";
  if (status === "draft") return "taslak";
  return status;
}

const LEVEL: Record<string, { tone: Tone; cls: string }> = {
  ok: { tone: "ok", cls: "text-brand-ink" },
  warn: { tone: "wait", cls: "text-wait-ink" },
  error: { tone: "err", cls: "text-err-ink" },
  skip: { tone: "off", cls: "text-ink-muted" },
};

/** Projenin son işleri — profil ekranının sol sütununda. */
function ProjectJobsList({ projectId }: { projectId: string }) {
  const jobs = useQuery({ queryKey: ["jobs", projectId], queryFn: () => api.jobs(projectId) });
  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[11px] uppercase tracking-[.1em] text-ink-muted">Bu projenin işleri</span>
      <div className="overflow-hidden rounded-xl border border-edge bg-surface">
        {(jobs.data ?? []).slice(0, 6).map((j) => {
          const tone = jobTone(j.state, j.phase);
          return (
            <Link
              key={j.id}
              to={`/jobs/${j.id}`}
              className="flex items-center gap-2 border-b border-edge px-3 py-2.5 no-underline last:border-b-0 hover:bg-raised"
            >
              <Dot tone={tone} pulse={tone === "run"} />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{j.title}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-ink-muted">{j.externalRef ?? "elle"}</span>
            </Link>
          );
        })}
        {jobs.data?.length === 0 && (
          <div className="px-3 py-4 text-center text-[12px] text-ink-dim">Henüz iş yok.</div>
        )}
      </div>
    </div>
  );
}

/**
 * Hedef repodaki issue şablonları (görev + hata). Bağlanırken sunucu eksikleri
 * PR olarak önerir; bu kart durumu gösterir ve öneri düşmüşse ya da workspace
 * özellikten önce bağlandıysa elle PR açtırır.
 */
function IssueTemplatesCard({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const info = useQuery({
    queryKey: ["issue-templates", projectId],
    queryFn: () => api.issueTemplates(projectId),
    retry: false,
    staleTime: 60_000,
  });
  const propose = useMutation({
    mutationFn: () => api.proposeIssueTemplates(projectId),
    onSuccess: (res) => qc.setQueryData(["issue-templates", projectId], res),
  });
  const s = info.data?.status ?? null;
  // Repo GitHub değilse kart gösterilmez — söylenecek bir şey yok.
  if (info.data && !info.data.repo) return null;

  const link = (url: string, text: string) => (
    <a href={url} target="_blank" rel="noreferrer" className="text-brand-ink">
      {text} ↗
    </a>
  );
  return (
    <section className="overflow-hidden rounded-xl border border-edge bg-surface">
      <header className="flex items-center gap-2 border-b border-edge bg-raised px-[13px] py-2.5">
        <h2 className="text-[12.5px] font-semibold text-ink">Issue şablonları</h2>
        <div className="flex-1" />
        {s && (
          <Badge
            value={s.state === "present" ? "kurulu" : s.state === "missing" ? "eksik" : s.state === "declined" ? "reddedildi" : "PR bekliyor"}
            tone={s.state === "present" ? "ok" : s.state === "missing" ? "wait" : s.state === "declined" ? "off" : "run"}
          />
        )}
      </header>
      <div className="flex flex-col gap-2 px-[13px] py-[11px] text-[12px] text-ink-body">
        {info.isLoading && <span className="text-ink-muted">GitHub'a bakılıyor…</span>}
        {s?.state === "present" && <span>Görev ve hata şablonları repoda.</span>}
        {(s?.state === "pending" || s?.state === "opened") && <span>Öneri PR'ı açık: {link(s.url, "PR")}</span>}
        {s?.state === "declined" && <span>Öneri PR'ı kapatılmış, tekrar önerilmez: {link(s.url, "PR")}</span>}
        {s?.state === "missing" && (
          <>
            <span className="aht-wrap font-mono text-[11px] text-ink-muted">{s.missing.join(", ")}</span>
            <Button variant="ghost" size="sm" className="self-start" disabled={propose.isPending} onClick={() => propose.mutate()}>
              {propose.isPending ? "PR açılıyor…" : "PR ile öner"}
            </Button>
          </>
        )}
        <ErrorText error={info.error} />
        <ErrorText error={propose.error} />
      </div>
    </section>
  );
}

type ProfileTab = "doc" | "rationale" | "validation";

function ProfileView({
  projectId,
  profile,
  onDecide,
  pending,
  error,
  imageBuildId,
  onImageBuildStarted,
  onSaved,
  onDeleted,
}: {
  projectId: string;
  profile: ProfileFull;
  onDecide: (d: "approve" | "reject", c: string) => void;
  pending: boolean;
  error: unknown;
  /** Onaydan dönen build kimliği; null ise bu profilin bilinen bir build'i yok. */
  imageBuildId: string | null;
  onImageBuildStarted: (id: string) => void;
  onSaved: (row: { id: string; droppedFields?: string[] }) => void;
  onDeleted: () => void;
}) {
  const [comment, setComment] = useState("");
  const [tab, setTab] = useState<ProfileTab>("doc");
  const isDraft = profile.status === "draft";
  const validation = useMutation({ mutationFn: () => api.validateProfile(profile.id) });
  // Toplu taşıma: koşan işler atlanır, sonuç sayıyla döner. Yalnız ONAYLI
  // profilde anlamlı — taslağa taşımayı sunucu zaten reddeder.
  const viewQc = useQueryClient();
  const applyAll = useMutation({
    mutationFn: () => api.applyProfileToJobs(profile.id),
    // Taşıma sonrası sayaç tazelenmeli; yoksa düğme hâlâ eski sayıyı gösterir
    // ve ikinci kez basılınca "0 iş taşındı" der.
    onSuccess: () => void viewQc.invalidateQueries({ queryKey: ["jobs"] }),
  });
  // KAÇ İŞ TAŞINACAK, düğmeye basmadan önce görünür.
  //
  // YAŞANDI: düğme "Tüm işlere uygula" diyordu ama projedeki her iş zaten bu
  // profildeyse hiçbir şey olmuyordu — kullanıcıya bozuk görünüyor. Sayı
  // düğmenin üstünde durursa "yapacak iş yok" da bir cevap olur.
  const jobs = useQuery({
    queryKey: ["jobs", projectId],
    queryFn: () => api.jobs(projectId),
    staleTime: 10_000,
  });
  const staleJobs = jobs.data?.filter((j) => j.profileId !== profile.id) ?? [];
  const del = useMutation({
    mutationFn: () => api.deleteProfile(profile.id),
    onSuccess: onDeleted,
  });

  // Düzenleme: onaylı bir profili düzenlemek de mümkün — kaydetmek YENİ bir
  // taslak sürüm doğurur (saveProfileDraft, kural: onay kapısı korunur),
  // onaylı satır değişmez. Taslak state'i `ProfileEditor`de yaşar.
  const [editing, setEditing] = useState(false);

  function validate() {
    setTab("validation");
    validation.mutate();
  }

  const ruleCount = profile.rationale ? Object.keys(profile.rationale).length : 0;

  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-edge bg-surface">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-edge bg-raised px-5 py-3">
        <h2 className="text-[14px] font-semibold text-ink">Profil v{profile.version}</h2>
        <Badge value={profileStatusLabel(profile.status)} tone={profileTone(profile.status)} />
        <span className="font-mono text-[11px] text-ink-muted">
          {profile.analysisId ? "analizden" : "elle"} · {fmtTime(profile.createdAt)}
        </span>
        <span className="flex-1" />
        {editing ? (
          <span className="text-[12.5px] text-ink-soft">düzenleniyor</span>
        ) : (
          <>
            {validation.data && validation.data.errors > 0 && (
              <span className="text-[12.5px] text-err-text">{validation.data.errors} doğrulama hatası giderilmeli</span>
            )}
            <Button variant="neutral" size="sm" onClick={() => setEditing(true)}>
              Düzenle
            </Button>
            <Button variant="neutral" size="sm" disabled={validation.isPending} onClick={validate}>
              Doğrula
            </Button>
            {profile.status === "approved" && (
              <Button
                variant="neutral"
                size="sm"
                // Taşınacak iş yoksa düğme KAPALI: basıp hiçbir şey olmaması,
                // düğmenin bozuk olduğu izlenimi veriyordu.
                disabled={applyAll.isPending || staleJobs.length === 0}
                title={
                  staleJobs.length === 0
                    ? "Projedeki tüm işler zaten bu profil sürümünde"
                    : `${staleJobs.length} iş bu profile taşınacak; koşan işler atlanır ve sayaçlar sıfırlanır`
                }
                onClick={() => {
                  // Onay: işlerin loop sayaçları sıfırlanıyor ve profilleri
                  // değişiyor — geri alma tek tek retarget demek.
                  if (confirm(`${staleJobs.length} iş profil v${profile.version}'e taşınsın mı? Koşan işler atlanır, sayaçlar sıfırlanır.`)) {
                    applyAll.mutate();
                  }
                }}
              >
                {applyAll.isPending
                  ? "Taşınıyor…"
                  : staleJobs.length === 0
                    ? "Tüm işler bu profilde"
                    : `Tüm işlere uygula (${staleJobs.length})`}
              </Button>
            )}
            <Button
              variant="danger"
              size="sm"
              disabled={del.isPending}
              onClick={() => {
                // Sunucu zaten bağlı iş varsa 409 ile reddeder; onay burada
                // yalnız yanlışlıkla tıklamayı önlüyor, iş güvencesi değil.
                if (confirm(`Profil v${profile.version} silinsin mi? Bu işlem geri alınamaz.`)) {
                  del.mutate();
                }
              }}
            >
              Sil
            </Button>
            {isDraft && (
              <>
                <Input
                  className="h-[30px] w-56 text-[12px]"
                  placeholder="yorum (red için)"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
                <Button variant="danger" size="sm" disabled={pending} onClick={() => onDecide("reject", comment)}>
                  Reddet
                </Button>
                <Button variant="primary" size="sm" disabled={pending} onClick={() => onDecide("approve", "")}>
                  Onayla
                </Button>
              </>
            )}
          </>
        )}
      </header>

      {editing ? (
        <ProfileEditor projectId={projectId} profile={profile} onCancel={() => setEditing(false)} onSaved={(row) => {
          setEditing(false);
          onSaved(row);
        }} />
      ) : (
        <>
          <nav className="flex items-center gap-0.5 border-b border-edge px-5">
            <TabButton active={tab === "doc"} onClick={() => setTab("doc")}>
              Belge
            </TabButton>
            <TabButton active={tab === "rationale"} onClick={() => setTab("rationale")}>
              Gerekçeler
              {ruleCount > 0 && <TabCount tone="off">{ruleCount}</TabCount>}
            </TabButton>
            <TabButton active={tab === "validation"} onClick={() => setTab("validation")}>
              Doğrulama
              {validation.data && (validation.data.errors > 0 || validation.data.warnings > 0) && (
                <TabCount tone={validation.data.errors > 0 ? "err" : "wait"}>
                  {validation.data.errors > 0 ? validation.data.errors : validation.data.warnings}
                </TabCount>
              )}
            </TabButton>
          </nav>

          <div className="px-6 pt-5 pb-8">
            <ErrorText error={error ?? validation.error ?? del.error ?? applyAll.error} />

            {/* Toplu taşıma sonucu: atlananlar ADIYLA listelenir — "3 iş atlandı"
                demek, hangilerinin elle taşınacağını söylemiyor. */}
            {applyAll.data && (
              <div className="mb-4 rounded-xl border border-edge bg-raised p-3">
                <div className="text-[12.5px] font-medium text-ink">
                  {applyAll.data.moved} iş v{applyAll.data.version}'e taşındı
                  {applyAll.data.alreadyOnTarget > 0 ? ` · ${applyAll.data.alreadyOnTarget} iş zaten bu profildeydi` : ""}
                  {applyAll.data.skipped.length > 0 ? ` · ${applyAll.data.skipped.length} iş atlandı` : ""}
                </div>
                {applyAll.data.skipped.length > 0 && (
                  <ul className="mt-2 flex max-h-48 flex-col gap-1 overflow-auto">
                    {applyAll.data.skipped.map((s) => (
                      <li key={s.id} className="flex items-start gap-2 text-[12px]">
                        <Dot tone="wait" size={6} />
                        <Link to={`/jobs/${s.id}`} className="min-w-0 flex-1 truncate text-ink-soft no-underline hover:text-ink">
                          {s.title}
                        </Link>
                        <span className="shrink-0 text-ink-muted">{s.reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <ImageBuildPanel profileId={profile.id} buildId={imageBuildId} onStarted={onImageBuildStarted} />

            <div className="max-w-[78ch]">
              {tab === "doc" && <ProfileDoc doc={profile.document} />}

              {tab === "rationale" &&
                (profile.rationale ? (
                  <ul className="flex flex-col gap-2">
                    {Object.entries(profile.rationale).map(([k, v]) => (
                      <li key={k} className="rounded-xl border border-edge bg-raised px-3 py-2.5">
                        <div className="font-mono text-[11px] text-accent-ink">{k}</div>
                        <div className="mt-0.5 text-[13px] leading-relaxed text-ink-body">{v.why}</div>
                        <div className="mt-0.5 font-mono text-[11px] text-ink-muted">{v.source}</div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[13px] text-ink-muted">Gerekçe yok (elle yazılmış olabilir).</p>
                ))}

              {tab === "validation" &&
                (validation.data ? (
                  <div className="rounded-xl border border-edge bg-raised p-3">
                    <div className={`text-[12.5px] font-medium ${validation.data.ok ? "text-brand-ink" : "text-err-ink"}`}>
                      {validation.data.errors} hata · {validation.data.warnings} uyarı
                      {validation.data.ok ? " — onaylanabilir" : " — önce hataları gider"}
                    </div>
                    <ul className="mt-2 flex flex-col gap-1">
                      {validation.data.checks.map((c) => {
                        const lv = LEVEL[c.level] ?? LEVEL.skip!;
                        return (
                          <li key={c.id} className="flex items-start gap-2 text-[12px]">
                            <Dot tone={lv.tone} size={6} />
                            <span className="font-mono text-[11px] text-ink-muted">{c.id}</span>
                            <span className={lv.cls}>{c.message}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 rounded-xl border border-edge bg-raised px-3 py-2.5">
                    <span className="text-[12.5px] text-ink-muted">
                      {validation.isPending ? "doğrulanıyor…" : "Bu sürüm henüz doğrulanmadı."}
                    </span>
                    <span className="flex-1" />
                    <Button variant="neutral" size="sm" disabled={validation.isPending} onClick={validate}>
                      Doğrula
                    </Button>
                  </div>
                ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-[7px] border-b-2 px-3 py-[11px] text-[13px] ${
        active ? "border-brand font-semibold text-brand-ink" : "border-transparent font-medium text-ink-soft hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function TabCount({ tone, children }: { tone: "err" | "wait" | "off"; children: ReactNode }) {
  const cls = tone === "err" ? "bg-err-tint text-err-ink" : tone === "wait" ? "bg-wait-tint text-wait-ink" : "bg-chip text-off-ink";
  return <span className={`rounded-[5px] px-1.5 py-px font-mono text-[10.5px] ${cls}`}>{children}</span>;
}

/**
 * İmaj build paneli — profil onayının görünmeyen yarısı.
 *
 * Onay imajı build etmeye başladıysa (`imageBuildId`) durumu 2 sn'de bir
 * yoklar; bitince log kuyruğunu gösterir, düşmüşse yeniden denemeyi sunar.
 * WS DEĞİL polling: olay akışı iş kimliğine bağlı, bu build ise profil
 * seviyesinde ve henüz ortada iş yok.
 *
 * Bilinen bir build yoksa geçmişteki son build gösterilir — sayfa yenilendikten
 * sonra da "imaj neden yok" sorusu cevaplanabilsin.
 */
function ImageBuildPanel({
  profileId,
  buildId,
  onStarted,
}: {
  profileId: string;
  buildId: string | null;
  onStarted: (id: string) => void;
}) {
  const history = useQuery({
    queryKey: ["image-builds", profileId],
    queryFn: () => api.imageBuilds(profileId),
  });
  // Onaydan dönen kimlik yoksa geçmişin en yenisine düşülür.
  const trackedId = buildId ?? history.data?.[0]?.id ?? null;

  const build = useQuery({
    queryKey: ["image-build", trackedId],
    queryFn: () => api.imageBuild(trackedId!),
    enabled: Boolean(trackedId),
    refetchInterval: (q) => (q.state.data?.status === "running" ? 2000 : false),
  });

  const status = build.data?.status ?? null;
  const log = useQuery({
    queryKey: ["image-build-log", trackedId, status],
    queryFn: () => api.imageBuildLog(trackedId!),
    // Log dosyası build BİTİNCE yazılıyor (satır satır dosya açmak pahalıydı);
    // koşarken sorgulamak boş metin döndürürdü.
    enabled: Boolean(trackedId) && status !== null && status !== "running",
  });

  const rebuild = useMutation({
    mutationFn: () => api.buildImage(profileId),
    onSuccess: (res) => {
      onStarted(res.imageBuildId);
      void history.refetch();
    },
  });

  // Build kaydı yoksa (imaj elle build edilmiş, ya da profil hiç onaylanmamış)
  // dolu panel yerine tek satır: durum anlatacak bir şey yok ama build etmenin
  // yolu OLMALI. Eskiden burada `return null` vardı ve tarifi düzelten
  // kullanıcının UI'dan imajı tazelemesi imkânsızdı.
  if (!trackedId || !build.data) {
    return (
      <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-edge bg-raised px-3 py-2">
        <span className="text-[12px] text-ink-muted">Bu profil için kayıtlı imaj build'i yok.</span>
        <span className="flex-1" />
        <Button variant="neutral" size="sm" disabled={rebuild.isPending} onClick={() => rebuild.mutate()}>
          İmajı build et
        </Button>
        <ErrorText error={rebuild.error} />
      </div>
    );
  }

  const b = build.data;
  const tone: Tone = b.status === "succeeded" ? "ok" : b.status === "failed" ? "err" : "wait";

  return (
    <div className="mb-4 rounded-xl border border-edge bg-raised p-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <Dot tone={tone} size={7} />
        <span className="text-[12.5px] font-medium text-ink">
          {b.status === "running"
            ? "İmaj build ediliyor"
            : b.status === "succeeded"
              ? "İmaj hazır"
              : "İmaj build'i düştü"}
        </span>
        <span className="font-mono text-[11px] text-ink-muted">{b.imageRef}</span>
        <span className="text-[11px] text-ink-muted">{fmtAge(b.createdAt)}</span>
        <span className="flex-1" />
        {/*
          Başarılı build'de de sunulur. YAŞANDI (2026-09-20): `USER agent`
          taşıyan bir tarif build'den YEŞİL geçti (Docker `USER`ı o an
          doğrulamaz) ve iş saatler sonra Planning'de düştü. Tarifi düzelten
          kullanıcının elinde yeniden build etmenin UI yolu yoktu — düğme
          yalnız `failed`da çıkıyordu. Başarılı bir build, imajın DOĞRU
          olduğunu kanıtlamıyor.
        */}
        {b.status !== "running" && (
          <Button variant="neutral" size="sm" disabled={rebuild.isPending} onClick={() => rebuild.mutate()}>
            {b.status === "failed" ? "Yeniden dene" : "Yeniden build et"}
          </Button>
        )}
      </div>

      <ErrorText error={rebuild.error} />
      {b.error && <div className="mt-2 text-[12px] text-err-ink">{b.error}</div>}

      {b.status === "running" && (
        <p className="mt-2 text-[12px] text-ink-muted">
          Bu birkaç dakika sürebilir; çıktı bitince görünür.
        </p>
      )}
      {log.data && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-2.5 font-mono text-[11px] text-ink-body">
          {log.data.split("\n").slice(-200).join("\n")}
        </pre>
      )}
    </div>
  );
}
