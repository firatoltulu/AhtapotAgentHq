import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { CodeMapModule } from "@ahtapot/shared";

import { api, type AgentReadStats } from "../api";
import { Badge, Button, ErrorText, fmtAge, fmtTime } from "../ui";

/**
 * Kod haritası (karar §35): durum, elle üretim, künyeler ve kullanım ölçümü.
 *
 * Kullanım satırı haritanın asıl sorusunu cevaplar: agent'lar `/codemap`i
 * gerçekten okuyor mu? Okumuyorsa harita (ve üstüne kurulacak öğrenilen
 * notlar) maliyetten ibarettir — §35'in ölçütü `agent-reads`.
 */
export function CodeMapCard({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const key = ["codemap", projectId];
  const info = useQuery({
    queryKey: key,
    queryFn: () => api.codeMap(projectId),
    retry: false,
    // Üretim dakikalar sürer; koşarken sık, yoksa seyrek yokla.
    refetchInterval: (q) => (q.state.data?.running ? 3_000 : 60_000),
  });
  const [open, setOpen] = useState(false);
  const content = useQuery({
    queryKey: ["codemap-content", projectId],
    queryFn: () => api.codeMapContent(projectId),
    enabled: open,
    retry: false,
  });

  // Üretim bitince açık künye listesi eski haritayı göstermesin.
  const running = Boolean(info.data?.running);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) void qc.invalidateQueries({ queryKey: ["codemap-content", projectId] });
    wasRunning.current = running;
  }, [running, qc, projectId]);

  const generate = useMutation({
    mutationFn: () => api.generateCodeMap(projectId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });

  const s = info.data;
  const badge = !s
    ? null
    : !s.enabled
      ? { value: "kapalı", tone: "off" as const }
      : s.running
        ? { value: "üretiliyor", tone: "run" as const }
        : s.generatedAt
          ? { value: `${s.modules} modül`, tone: s.stale.length > 0 ? ("wait" as const) : ("ok" as const) }
          : { value: "yok", tone: "wait" as const };

  return (
    <section className="overflow-hidden rounded-xl border border-edge bg-surface">
      <header className="flex items-center gap-2 border-b border-edge bg-raised px-[13px] py-2.5">
        <h2 className="text-[12.5px] font-semibold text-ink">Kod haritası</h2>
        <div className="flex-1" />
        {badge && <Badge value={badge.value} tone={badge.tone} />}
      </header>
      <div className="flex flex-col gap-2 px-[13px] py-[11px] text-[12px] text-ink-body">
        {info.isLoading && <span className="text-ink-muted">Yükleniyor…</span>}
        {info.error && <ErrorText error={info.error} />}

        {s && !s.enabled && (
          <span className="text-ink-muted">
            Onaylı profilde kapalı. <span className="font-mono">agents.codeMap.enabled</span> taslakta açıksa profil
            onaylanınca geçerli olur.
          </span>
        )}

        {s?.enabled && (
          <>
            {s.generatedAt ? (
              <div className="flex flex-col gap-0.5">
                <span>
                  Üretildi: {fmtTime(s.generatedAt)} <span className="text-ink-muted">({fmtAge(s.generatedAt)} önce)</span>
                </span>
                <span className="text-ink-muted">
                  {s.modules} modül
                  {s.stale.length > 0 && ` · ${s.stale.length} bayat`}
                  {s.unmapped > 0 && ` · haritasız değişen ${s.unmapped} dosya`}
                </span>
                {Object.entries(s.commits).map(([repo, sha]) => (
                  <span key={repo} className="text-ink-muted">
                    {repo} @ <span className="font-mono text-[11px]">{sha.slice(0, 10)}</span>
                  </span>
                ))}
              </div>
            ) : (
              !s.running && (
                <span className="text-ink-muted">Harita henüz yok. İlk işte kendiliğinden üretilir ya da buradan başlatılır.</span>
              )
            )}
            {s.running && <span className="text-ink-muted">Haritacı çalışıyor; birkaç dakika sürebilir.</span>}
            {s.lastError && <ErrorText error={`Son üretim düştü: ${s.lastError}`} />}

            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="neutral" disabled={s.running || generate.isPending} onClick={() => generate.mutate()}>
                {s.generatedAt ? "Yeniden üret" : "Haritayı üret"}
              </Button>
              {s.generatedAt && (
                <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
                  {open ? "Künyeleri gizle" : "Künyeleri göster"}
                </Button>
              )}
            </div>
            {generate.error && <ErrorText error={generate.error} />}

            {s.generatedAt && <UsageLines projectId={projectId} />}

            {open && (
              <div className="flex flex-col gap-1.5">
                {content.isLoading && <span className="text-ink-muted">Yükleniyor…</span>}
                {content.error && <ErrorText error={content.error} />}
                {content.data && !content.data.map && <span className="text-ink-muted">Harita dosyası okunamadı.</span>}
                {content.data?.map?.modules.map((m) => <ModuleRow key={m.id} m={m} />)}
                {content.data?.map && content.data.map.unmapped.length > 0 && (
                  <details className="text-ink-muted">
                    <summary className="cursor-pointer">Haritasız değişen dosyalar ({content.data.map.unmapped.length})</summary>
                    <ul className="mt-0.5 flex flex-col gap-0.5 pl-3 font-mono text-[11px]">
                      {content.data.map.unmapped.map((f) => <li key={f}>{f}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Son işlerde haritayı okuyan iş sayısı, rol başına. `INDEX.md` yönlenme,
 * `modules/` künye okuması: INDEX okunup künye hiç açılmıyorsa harita
 * katalog olarak işe yarıyor ama derinliği kullanılmıyor.
 */
function UsageLines({ projectId }: { projectId: string }) {
  return (
    <div className="flex flex-col gap-0.5 text-ink-muted">
      <span className="font-mono text-[10.5px] tracking-[.1em] uppercase">Kullanım (son 20 iş)</span>
      <UsageLine projectId={projectId} role="planner" label="Planner" />
      <UsageLine projectId={projectId} role="developer" label="Developer" />
    </div>
  );
}

function UsageLine({ projectId, role, label }: { projectId: string; role: string; label: string }) {
  const q = useQuery({
    queryKey: ["agent-reads", projectId, role],
    queryFn: () => api.agentReads(projectId, role),
    retry: false,
    staleTime: 60_000,
  });
  if (!q.data) return null;
  const u = codeMapUsage(q.data);
  if (q.data.jobsAnalyzed === 0) return <span>{label}: henüz iş yok</span>;
  return (
    <span>
      {label}: INDEX {u.indexJobs}/{q.data.jobsAnalyzed} işte · künye {u.moduleReads} okuma ({u.moduleJobs} iş)
    </span>
  );
}

function codeMapUsage(stats: AgentReadStats): { indexJobs: number; moduleReads: number; moduleJobs: number } {
  let indexJobs = 0;
  let moduleReads = 0;
  let moduleJobs = 0;
  for (const f of stats.files) {
    const p = f.path.replace(/\\/g, "/");
    if (/(^|\/)codemap\/INDEX\.md$/.test(p)) indexJobs = Math.max(indexJobs, f.jobs);
    else if (/(^|\/)codemap\/modules\/[^/]+\.md$/.test(p)) {
      moduleReads += f.reads;
      // Farklı künyeler aynı işte okunabilir; toplamak işi şişirir, en büyüğü alt sınırdır.
      moduleJobs = Math.max(moduleJobs, f.jobs);
    }
  }
  return { indexJobs, moduleReads, moduleJobs };
}

function ModuleRow({ m }: { m: CodeMapModule }) {
  const stale = m.stale.length > 0;
  return (
    <details className="rounded-[6px] border border-edge px-2.5 py-1.5">
      <summary className="cursor-pointer">
        <span className="font-semibold text-ink">{m.name}</span>{" "}
        <span className="font-mono text-[10.5px] text-ink-muted">{m.id}</span>
        {stale && <Badge value="bayat" tone="wait" className="ml-1.5" />}
        <span className="block text-ink-muted">{m.purpose}</span>
      </summary>
      <div className="mt-1.5 flex flex-col gap-1">
        <Field label="Dizinler" items={m.paths.map((p) => `${m.repo}/${p}`)} mono />
        <Field label="Anahtar dosyalar" items={m.keyFiles.map((k) => (k.role ? `${k.path} — ${k.role}` : k.path))} mono />
        <Field label="Giriş noktaları" items={m.entryPoints} mono />
        <Field label="Sözleşmeler" items={m.contracts} mono />
        <Field label="Varlıklar" items={m.entities} />
        <Field label="Uçlar" items={m.endpoints} mono />
        <Field label="Bağımlılıklar" items={m.dependsOn} mono />
        <Field label="Tuzaklar" items={m.pitfalls} />
        {stale && <Field label="Son üretimden beri değişen" items={m.stale} mono />}
        {m.sha && (
          <span className="text-ink-muted">
            Künye commit'i <span className="font-mono text-[11px]">{m.sha.slice(0, 10)}</span>
            {m.updatedAt && ` · ${fmtTime(m.updatedAt)}`}
          </span>
        )}
      </div>
    </details>
  );
}

function Field({ label, items, mono = false }: { label: string; items: string[]; mono?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div>
      <span className="text-ink-muted">{label}:</span>
      <ul className={`mt-0.5 flex flex-col gap-0.5 pl-3 ${mono ? "font-mono text-[11px]" : ""}`}>
        {items.map((s, i) => <li key={i}>· {s}</li>)}
      </ul>
    </div>
  );
}
