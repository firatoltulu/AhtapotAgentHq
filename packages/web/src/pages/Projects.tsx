import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { parseGitRemote } from "@ahtapot/shared";

import { api, HttpError, type GithubRepoSummary, type Job, type Project } from "../api";
import {
  Badge,
  Button,
  Dot,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Modal,
  fmtAge,
  fmtUsd,
  gateLabel,
  isGateState,
} from "../ui";

/** Klon bitene dek yoklama aralığı — proje listesinin `refetchInterval`ı ile aynı. */
const CLONE_POLL_MS = 2000;
/**
 * Üst sınır: klon askıda kalırsa mutation sonsuza dek "kaydediliyor" görünmesin.
 * Sunucu yeniden başlarsa `reconcileInterruptedClones` satırı zaten `failed`e
 * çeker, ama süreç yaşıyor ve ağ yavaşsa tek fren bu.
 */
const CLONE_WAIT_TIMEOUT_MS = 30 * 60_000;

/**
 * `workspaceStatus` "pending"ten çıkana dek projeyi yoklar.
 *
 * Klonlu bağlamada `POST /api/projects` 202 döner ve klon arka planda sürer;
 * ardından gelen işlemler (analiz) workspace'in diskte GERÇEKTEN var olmasını
 * bekler. Zaman aşımında son bilinen satır döner — çağıran onu "failed" gibi
 * değil, "hâlâ pending" olarak görür ve kendi kararını verir.
 */
async function waitForWorkspace(
  id: string,
  initial: Project["workspaceStatus"],
): Promise<Pick<Project, "workspaceStatus" | "workspaceError">> {
  if (initial !== "pending") return { workspaceStatus: initial, workspaceError: null };
  const deadline = Date.now() + CLONE_WAIT_TIMEOUT_MS;
  let last: Pick<Project, "workspaceStatus" | "workspaceError"> = {
    workspaceStatus: initial,
    workspaceError: null,
  };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, CLONE_POLL_MS));
    let p: Project;
    try {
      p = await api.project(id);
    } catch (err) {
      // Proje zaten yaratıldı: tek bir ağ/5xx hatası otomatik analizi
      // atlatmasın (formu yeniden göndermek slug çakışmasıyla 409 verir).
      // 4xx kalıcıdır (proje yok, yetki) — onu hemen yüzeye çıkar.
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) throw err;
      continue;
    }
    last = { workspaceStatus: p.workspaceStatus, workspaceError: p.workspaceError };
    if (p.workspaceStatus !== "pending") return last;
  }
  return last;
}

/**
 * Anasayfa: bekleyen kapılar + koşan işler + projeler.
 *
 * Proje "bağlanır", kopyalanmaz: `workspaceRoot` sunucu diskinde var olmalı.
 * Kaynak workspace'e hiçbir zaman yazılmaz — iş worktree'de koşar.
 */
export function ProjectsPage() {
  const qc = useQueryClient();
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: api.projects,
    refetchInterval: (q) => (q.state.data?.some((p) => p.workspaceStatus === "pending") ? 2000 : false),
  });
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: () => api.jobs(), refetchInterval: 5000 });
  // Ayrı istek: liste `gh` çağrılarını beklemesin, rozet sonradan dolsun.
  const versions = useQuery({ queryKey: ["project-versions"], queryFn: api.projectVersions, staleTime: 5 * 60_000, retry: false });
  // Layout'taki ["system"] query'siyle AYNI key — React Query cache'i paylaşır,
  // ekstra ağ isteği açmaz.
  const system = useQuery({ queryKey: ["system"], queryFn: api.system });
  const [connecting, setConnecting] = useState(false);
  const [form, setForm] = useState({ slug: "", name: "", workspaceRoot: "", gitUrl: "" });
  const [analyzeAfter, setAnalyzeAfter] = useState(true);

  // Üç ayrı bağlama yolu: aynı `workspaceRoot`/`gitUrl` ikilisi ama form artık
  // hangi niyette olduğunu gizli tutmuyor — kullanıcı önce modu seçiyor.
  type ConnectMode = "existing" | "clone" | "github";
  const [mode, setMode] = useState<ConnectMode>("existing");

  // AHTAPOT_WORKSPACES_ROOT sunucuda tanımlıysa clone/github modunda hedef
  // yol elle istenmez — backend <kök>/<repo-adı> olarak kendisi türetir.
  // "existing" modu hiç etkilenmez, o zaten var olan bir dizini işaret eder.
  const hasWorkspacesRoot = system.data?.workspacesRoot ?? false;
  const autoTarget = mode !== "existing" && hasWorkspacesRoot;

  const repos = useQuery({
    queryKey: ["github-repos"],
    queryFn: api.githubRepos,
    enabled: connecting && mode === "github",
  });
  const [repoFilter, setRepoFilter] = useState("");
  const filteredRepos = (repos.data?.repos ?? []).filter((r) =>
    r.nameWithOwner.toLowerCase().includes(repoFilter.toLowerCase()),
  );

  const slugify = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  // Repo seçilince "klonla" moduna devreder — kullanıcı orada gitUrl/ad/slug'ı
  // dolu ama düzenlenebilir görür, ayrı bir "seçili repo" state'i gerekmez.
  const selectRepo = (r: GithubRepoSummary) => {
    const repoName = r.nameWithOwner.split("/")[1] ?? "";
    setForm((f) => ({
      ...f,
      gitUrl: `https://github.com/${r.nameWithOwner}.git`,
      slug: f.slug || slugify(repoName),
      name: f.name || repoName,
    }));
    setMode("clone");
  };

  // Yazarken 400ms sonra dizini sunucuda yokla — mockup'taki "Dizin bulundu ·
  // git deposu · remote ..." canlı satırı. Her tuş vuruşunda istek atmamak için debounce.
  const [probePath, setProbePath] = useState("");
  useEffect(() => {
    if (!connecting || !form.workspaceRoot) {
      setProbePath("");
      return;
    }
    const t = setTimeout(() => setProbePath(form.workspaceRoot), 400);
    return () => clearTimeout(t);
  }, [connecting, form.workspaceRoot]);
  const probe = useQuery({
    queryKey: ["workspace-probe", probePath],
    queryFn: () => api.workspaceProbe(probePath),
    enabled: probePath.length > 0,
  });

  // Sunucuyla AYNI kural (`parseGitRemote`): yazarken görünsün, "Bağla"dan
  // sonra 400 olarak değil. Bu adres PR'ın remote'u da olur.
  const gitUrlCheck = mode === "clone" && form.gitUrl.trim() ? parseGitRemote(form.gitUrl) : null;
  const gitUrlError = gitUrlCheck && !gitUrlCheck.ok ? gitUrlCheck.reason : null;
  const gitUrlNotGithub = gitUrlCheck?.ok && !gitUrlCheck.githubSlug;

  const create = useMutation({
    mutationFn: async () => {
      // `gitUrl` yalnız "klonla" modunda gönderilir — kullanıcı clone'da URL
      // yazıp sonra "mevcut yol"a geri dönerse form.gitUrl state'te kalır,
      // moda bakmadan göndermek "mevcut yol" isteğini yanlışlıkla klona çevirirdi.
      const project = await api.createProject({
        slug: form.slug,
        name: form.name,
        // `autoTarget` true iken ASLA gönderilmez — alan gizliyken kullanıcı
        // farkında olmadan eski bir form.workspaceRoot (başka moddan/`system`
        // henüz yüklenmeden yazılmış) state'te kalmış olabilir; yalnız boşluğa
        // bakmak bu bayat değerin backend'e sızmasını engellemezdi.
        ...(!autoTarget && form.workspaceRoot ? { workspaceRoot: form.workspaceRoot } : {}),
        ...(mode === "clone" && form.gitUrl ? { gitUrl: form.gitUrl } : {}),
      });
      // KLON BİTMEDEN ANALİZ BAŞLAMAZ. Klonlu bağlamada `createProject` 202
      // ile HEMEN döner, klon arkada sürer ve hedef dizin ancak bitince
      // yerine taşınır (clone.ts geçici dizine klonluyor) — analizi burada
      // zincirlemek onu var olmayan bir workspace'e yolluyor ve her klonlu
      // bağlama "workspace dizini artık yok" ile düşüyordu (yaşandı,
      // 2026-09-22). Analiz dakikalar sürdüğü için bu bekleme kullanıcıya
      // ayrıca maliyet çıkarmıyor; klon saniyeler mertebesinde.
      if (analyzeAfter) {
        const ready = await waitForWorkspace(project.id, project.workspaceStatus);
        if (ready.workspaceStatus === "failed") {
          throw new Error(`workspace klonu başarısız: ${ready.workspaceError ?? "sebep kaydedilmemiş"}`);
        }
        // Zaman aşımı: proje KURULDU, yalnız analiz başlatılamadı. Hata
        // metni bunu söylemeli — kullanıcı projeyi yeniden bağlamaya
        // çalışmasın, klon bitince detay ekranından analizi kendisi başlatsın.
        if (ready.workspaceStatus === "pending") {
          throw new Error("klon hâlâ sürüyor; proje bağlandı, analizi klon bitince başlatın");
        }
        await api.analyze(project.id);
      }
      return project;
    },
    onSuccess: () => {
      setForm({ slug: "", name: "", workspaceRoot: "", gitUrl: "" });
      setMode("existing");
      setConnecting(false);
    },
    // `onSuccess` DEĞİL: proje oluştuktan SONRAKİ adımlar (klon bekleme,
    // analiz) düşebilir ve o durumda da satır DB'de vardır. Hata yolunda
    // listeyi tazelemezsek kullanıcı modal'da hatayı görüp yeniden dener,
    // bu kez slug çakışmasından 409 alır ve projesinin zaten kurulduğunu
    // hiç öğrenemez.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id;

  const waiting: Job[] =
    jobs.data?.filter((j) => j.state === "NeedsAttention" || isGateState(j.state)).sort((a, b) =>
      a.updatedAt < b.updatedAt ? -1 : 1,
    ) ?? [];
  const running: Job[] =
    jobs.data?.filter((j) => (j.phase === "starting" || j.phase === "running") && !isGateState(j.state) && j.state !== "NeedsAttention") ?? [];

  return (
    <div className="h-full overflow-auto px-6 py-5">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-5">
        {waiting.length > 0 && (
          <section className="overflow-hidden rounded-xl border border-wait-edge bg-surface">
            <header className="flex items-center gap-3 border-b border-edge bg-wait-tint px-4 py-3">
              <Dot tone="wait" />
              <h2 className="text-[14px] font-semibold text-ink">Seni bekleyen {waiting.length} iş</h2>
            </header>
            <div className="flex flex-col">
              {waiting.map((j) => {
                const err = j.state === "NeedsAttention";
                return (
                  <Link
                    key={j.id}
                    to={`/jobs/${j.id}`}
                    className="flex items-center gap-3.5 border-b border-edge px-4 py-3 no-underline last:border-b-0 hover:bg-raised"
                  >
                    <Dot tone={err ? "err" : "wait"} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold text-ink">{j.title}</span>
                      <span className="block truncate font-mono text-[11px] text-ink-muted">
                        {projectName(j.projectId)}
                        {j.branchName ? ` · ${j.branchName}` : ""}
                      </span>
                    </span>
                    <span className={`w-[220px] shrink-0 truncate text-[12.5px] ${err ? "text-err-text" : "text-wait-ink"}`}>
                      {err ? (j.errorMessage || "Dikkat gerekiyor") : gateLabel(j.state)}
                    </span>
                    <Badge value={j.state} tone={err ? "err" : "wait"} />
                    <span className="w-[54px] shrink-0 text-right font-mono text-[11px] text-ink-muted">
                      {fmtAge(j.updatedAt)}
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {running.length > 0 && (
          <section className="overflow-hidden rounded-xl border border-edge bg-surface">
            <header className="flex items-center gap-3 border-b border-edge px-4 py-2.5">
              <h2 className="text-[13px] font-semibold text-ink">Koşan işler</h2>
              <span className="font-mono text-[11px] text-ink-muted">{running.length} iş · insan hamlesi gerekmiyor</span>
            </header>
            <div className="flex flex-col">
              {running.map((j) => (
                <Link
                  key={j.id}
                  to={`/jobs/${j.id}`}
                  className="flex items-center gap-3.5 border-b border-edge px-4 py-3 no-underline last:border-b-0 hover:bg-raised"
                >
                  <Dot tone="run" pulse />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-ink">{j.title}</span>
                    <span className="block truncate font-mono text-[11px] text-ink-muted">
                      {projectName(j.projectId)}
                      {j.branchName ? ` · ${j.branchName}` : ""}
                    </span>
                  </span>
                  <span className="w-[220px] shrink-0 truncate font-mono text-[11px] text-accent-ink">{j.state}</span>
                  <div className="h-1 w-[150px] shrink-0 overflow-hidden rounded-full bg-edge">
                    <div className="aht-pulse h-full w-full bg-run" />
                  </div>
                  <span className="w-[64px] shrink-0 text-right font-mono text-[11px] text-ink-muted">
                    {fmtUsd(j.costMicroUsd)}
                  </span>
                  <span className="w-[54px] shrink-0 text-right font-mono text-[11px] text-ink-muted">
                    {fmtAge(j.updatedAt)}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="rounded-xl border border-edge bg-surface">
          <header className="flex items-center gap-3 border-b border-edge px-4 py-3">
            <h1 className="text-[15px] font-semibold text-ink">Projeler</h1>
            <span className="font-mono text-[11px] text-ink-muted">
              {projects.data?.length ?? 0} bağlı workspace
            </span>
            <div className="flex-1" />
            <Button type="button" onClick={() => setConnecting(true)}>
              + Workspace bağla
            </Button>
          </header>

          {connecting && (
            <Modal
              title="Workspace bağla"
              subtitle="Proje bağlanır, kopyalanmaz — dizine hiçbir zaman yazılmaz."
              onClose={() => setConnecting(false)}
              footer={
                <>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">
                    POST /api/projects
                  </span>
                  <Button type="button" onClick={() => setConnecting(false)}>
                    Vazgeç
                  </Button>
                  <Button
                    type="submit"
                    form="connect-workspace-form"
                    variant="primary"
                    disabled={create.isPending || mode === "github" || gitUrlError !== null}
                  >
                    {analyzeAfter ? "Bağla ve analiz et" : "Bağla"}
                  </Button>
                </>
              }
            >
              <form
                id="connect-workspace-form"
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  create.mutate();
                }}
              >
                <div className="flex gap-1.5 rounded-[10px] border border-edge bg-raised p-1">
                  {(["existing", "clone", "github"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={`flex-1 rounded-[7px] px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
                        mode === m ? "bg-surface text-ink shadow-sm" : "text-ink-soft hover:text-ink"
                      }`}
                    >
                      {m === "existing" ? "Mevcut yol" : m === "clone" ? "Klonla (URL)" : "GitHub'dan seç"}
                    </button>
                  ))}
                </div>

                {mode === "github" && (
                  <div className="flex flex-col gap-2">
                    <Field label="Repo ara">
                      <Input
                        value={repoFilter}
                        onChange={(e) => setRepoFilter(e.target.value)}
                        placeholder="owner/repo…"
                        autoFocus
                      />
                    </Field>
                    <div className="flex max-h-[240px] flex-col overflow-auto rounded-xl border border-edge">
                      {repos.isLoading && <div className="px-3 py-4 text-[12.5px] text-ink-dim">repolar yükleniyor…</div>}
                      <ErrorText error={repos.error} />
                      {repos.data && filteredRepos.length === 0 && (
                        <div className="px-3 py-4 text-[12.5px] text-ink-dim">eşleşen repo yok</div>
                      )}
                      {filteredRepos.map((r) => (
                        <button
                          key={r.nameWithOwner}
                          type="button"
                          onClick={() => selectRepo(r)}
                          className="flex flex-col items-start gap-0.5 border-b border-edge px-3 py-2.5 text-left last:border-b-0 hover:bg-raised"
                        >
                          <span className="flex items-center gap-2 font-mono text-[12.5px] text-ink">
                            {r.nameWithOwner}
                            {r.isPrivate && <Badge value="private" tone="off" />}
                          </span>
                          {r.description && (
                            <span className="truncate text-[11.5px] text-ink-muted">{r.description}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {autoTarget ? (
                  <div className="rounded-xl border border-edge bg-raised px-3.5 py-2.5 text-[12.5px] text-ink-body">
                    Otomatik: sunucudaki workspace kökü altına, repo adıyla klonlanacak.
                  </div>
                ) : (
                  <Field label="Workspace yolu · sunucu diski">
                    <Input
                      value={form.workspaceRoot}
                      onChange={(e) => setForm({ ...form, workspaceRoot: e.target.value })}
                      placeholder="C:\src\northwind"
                      required
                      autoFocus={mode !== "github"}
                    />
                  </Field>
                )}
                {probePath && probePath === form.workspaceRoot && (
                  <div className="-mt-2 text-[12.5px]">
                    {probe.isLoading && <span className="text-ink-dim">yol denetleniyor…</span>}
                    {mode === "existing" ? (
                      <>
                        {probe.data && !probe.data.exists && (
                          <span className="flex items-center gap-2 text-wait-ink">
                            <Dot tone="wait" size={7} />
                            Dizin bulunamadı — Git adresi verirsen buradan klonlanır.
                          </span>
                        )}
                        {probe.data?.exists && !probe.data.isRepo && (
                          <span className="flex items-center gap-2 text-wait-ink">
                            <Dot tone="wait" size={7} />
                            Dizin var ama git deposu değil.
                          </span>
                        )}
                        {probe.data?.exists && probe.data.isRepo && (
                          <span className="flex items-center gap-2 text-ok-ink">
                            <Dot tone="ok" size={7} />
                            Dizin bulundu · git deposu
                            {probe.data.remoteUrl && (
                              <span className="font-mono text-[11.5px]">· remote {probe.data.remoteUrl}</span>
                            )}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        {probe.data && !probe.data.exists && (
                          <span className="flex items-center gap-2 text-ok-ink">
                            <Dot tone="ok" size={7} />
                            Dizin boş/yok — buraya klonlanacak.
                          </span>
                        )}
                        {probe.data?.exists && (
                          <span className="flex items-center gap-2 text-err-text">
                            <Dot tone="err" size={7} />
                            Bu yol zaten var — klonlama başarısız olur, boş bir yol seçin.
                          </span>
                        )}
                      </>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3.5">
                  <Field label="Ad">
                    <Input
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="Northwind"
                      required
                    />
                  </Field>
                  <Field label="Slug · küçük harf, tire">
                    <Input
                      value={form.slug}
                      onChange={(e) => setForm({ ...form, slug: e.target.value })}
                      placeholder="northwind"
                      required
                    />
                  </Field>
                </div>

                {mode === "clone" && (
                  <Field label="Git adresi · dizin yoksa buradan klonlanır">
                    <Input
                      value={form.gitUrl}
                      onChange={(e) => setForm({ ...form, gitUrl: e.target.value })}
                      placeholder="https://github.com/org/repo.git"
                      required
                    />
                    {gitUrlError && <span className="mt-1 block text-[12px] text-err-text">{gitUrlError}</span>}
                    {gitUrlNotGithub && (
                      <span className="mt-1 block text-[12px] text-wait-ink">
                        GitHub adresi değil — klonlanır ama PR açılamaz.
                      </span>
                    )}
                  </Field>
                )}

                <div className="flex flex-col gap-2 rounded-xl border border-edge bg-raised px-4 py-3">
                  <span className="text-[12.5px] font-semibold text-ink">Bağladıktan sonra ne oluyor</span>
                  <div className="flex gap-2.5 text-[12.5px] leading-relaxed text-ink-body">
                    <span className="w-3.5 shrink-0 font-mono text-[11px] text-brand-ink">1</span>
                    <span>Analyst workspace'i okur ve profil taslağı yazar.</span>
                  </div>
                  <div className="flex gap-2.5 text-[12.5px] leading-relaxed text-ink-body">
                    <span className="w-3.5 shrink-0 font-mono text-[11px] text-brand-ink">2</span>
                    <span>Profili onayladıktan sonra iş açılabilir — onaysız profille iş başlamaz.</span>
                  </div>
                  <div className="flex gap-2.5 text-[12.5px] leading-relaxed text-ink-body">
                    <span className="w-3.5 shrink-0 font-mono text-[11px] text-brand-ink">3</span>
                    <span>Her iş ayrı worktree'de koşar; kaynak dizin salt okunur kalır.</span>
                  </div>
                </div>

                <label className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={analyzeAfter}
                    onChange={(e) => setAnalyzeAfter(e.target.checked)}
                    className="mt-[3px] h-[17px] w-[17px] shrink-0 rounded-[5px] accent-brand"
                  />
                  <span className="text-[13px] leading-relaxed text-ink-body">
                    Bağlantı kurulunca <strong className="font-semibold text-ink">analizi hemen başlat</strong>
                    <span className="block text-[12px] text-ink-dim">
                      Yaklaşık 2 dakika · dosyalar okunur, kod yazılmaz.
                    </span>
                  </span>
                </label>

                <ErrorText error={create.error} />
              </form>
            </Modal>
          )}

          <ErrorText error={projects.error} />
          <div className="flex flex-col">
            {projects.isLoading && <div className="px-4 py-6 text-[13px] text-ink-dim">yükleniyor…</div>}
            {projects.data?.length === 0 && (
              <EmptyState title="Henüz proje yok">
                Sağdan bir workspace bağla. Dizin sunucu diskinde var olmalı; içeriğine dokunulmaz.
              </EmptyState>
            )}
            {projects.data?.map((p) => {
              const { waiting: pw, running: pr, costMicroUsd } = p.jobStats;
              return (
                <Link
                  key={p.id}
                  to={`/projects/${p.id}`}
                  className="flex items-center gap-3.5 border-b border-edge px-4 py-3.5 no-underline last:border-b-0 hover:bg-raised"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-[14px] font-semibold text-ink">{p.name}</span>
                      <span className="shrink-0 font-mono text-[11px] text-ink-muted">{p.slug}</span>
                      {versions.data?.[p.id]?.tag && (
                        <span
                          className="shrink-0 rounded-full border border-edge px-1.5 font-mono text-[10.5px] text-ink-soft"
                          title={`${versions.data[p.id]?.repo ?? ""} — son sürüm tag'i`}
                        >
                          {versions.data[p.id]?.tag}
                        </span>
                      )}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-ink-muted">{p.workspaceRoot}</span>
                  </span>

                  {p.workspaceStatus === "pending" && (
                    <span className="flex w-[150px] shrink-0 items-center gap-[7px] font-mono text-[11px] text-run-ink">
                      <Dot tone="run" pulse />
                      klonlanıyor
                    </span>
                  )}
                  {p.workspaceStatus === "failed" && (
                    <span className="w-[150px] shrink-0">
                      <Badge value="klon başarısız" tone="err" />
                    </span>
                  )}
                  {p.runningAnalysisId && (
                    <span className="flex w-[150px] shrink-0 items-center gap-[7px] font-mono text-[11px] text-run-ink">
                      <Dot tone="run" pulse />
                      analiz sürüyor
                    </span>
                  )}
                  {p.workspaceStatus === "ready" && !p.runningAnalysisId && (
                    <span className="w-[150px] shrink-0" />
                  )}

                  <Badge
                    value={p.activeProfileId ? `profil v${p.activeProfileVersion ?? "?"} onaylı` : "profil yok"}
                    tone={p.activeProfileId ? "ok" : "off"}
                  />

                  <span className="w-[120px] shrink-0 text-[12.5px] text-ink-body">
                    {p.runningAnalysisId
                      ? "iş açılamaz"
                      : pw === 0 && pr === 0
                        ? "iş yok"
                        : [pw > 0 ? `${pw} bekleyen` : null, pr > 0 ? `${pr} koşan` : null].filter(Boolean).join(" · ")}
                  </span>

                  <span className="w-[100px] shrink-0 text-right font-mono text-[11px] text-ink-muted">
                    {fmtUsd(costMicroUsd)}
                  </span>
                  <span className="w-[54px] shrink-0 text-right font-mono text-[11px] text-ink-muted">
                    {fmtAge(p.createdAt)}
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
