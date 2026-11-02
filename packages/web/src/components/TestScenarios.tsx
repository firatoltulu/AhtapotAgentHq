import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { scenarioKey, type ScenarioMark, type ScenarioMarkState, type ScenarioMarks, type TestScenario, type TestScenariosDocument } from "@ahtapot/shared";

import { api, type TestScenariosRow, type TestScenariosView } from "../api";
import { Badge, Button, ErrorText, Modal, Textarea, fmtClock, type Tone } from "../ui";
import { CritiqueCard } from "./CritiqueCard";

// Öncelik renksiz: işaret düğmeleri (kaldı kırmızı, kararsız turuncu) aynı
// tonları kullanıyor ve yan yana dururken "yüksek" bir işaret sanılıyordu.
const PRIORITY: Record<TestScenario["priority"], { label: string }> = {
  high: { label: "yüksek" },
  medium: { label: "orta" },
  low: { label: "düşük" },
};

const STAGE_TR = { plan: "plandan", live: "plan + değişikliklerden" } as const;

/** İnsanın koyabildiği işaretler; `retest`i motor yazar. */
type HumanMark = "pass" | "fail" | "unsure";

const MARK_TR: Record<ScenarioMarkState, string> = {
  pass: "✓ geçti",
  fail: "✗ kaldı",
  unsure: "? kararsız",
  retest: "↻ tekrar test et",
};
const markText = (m: ScenarioMark | undefined): string =>
  m ? ` · ${MARK_TR[m.state]}${m.note ? ` — ${m.note.replace(/\s+/g, " ")}` : ""}` : "";

/**
 * Canlı test senaryoları — insanın porttan ELLE koşacağı adımlar.
 *
 * Plan kapısında ve canlı test kapısında aynı kart: planda üretilen liste
 * canlı teste taşınır (en son hazır olan gösterilir), orada "yeniden çıkar"
 * gerçek diff'e göre günceller. Üretim iş durumunu değiştirmez; sürerken
 * sunucu onay ve sohbeti "iş koşuyor" diye reddeder (köprü tek koşu alır).
 */
export function TestScenariosCard({
  jobId,
  canGenerate,
  canMark = false,
  listless = false,
}: {
  jobId: string;
  canGenerate: boolean;
  canMark?: boolean;
  /** QA sekmesinde liste tezgâhta (`QaWorkbench`); kart yalnız üretim ve ikinci göz için kalır. */
  listless?: boolean;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["testScenarios", jobId],
    queryFn: () => api.testScenarios(jobId),
    // Yalnız üretim sürerken yoklanır; hazır liste değişmez.
    refetchInterval: (query) => (query.state.data?.latest?.status === "running" ? 3000 : false),
  });
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const generate = useMutation({
    mutationFn: () => api.generateTestScenarios(jobId, note.trim()),
    onSuccess: () => {
      setNote("");
      setNoteOpen(false);
      void qc.invalidateQueries({ queryKey: ["testScenarios", jobId] });
    },
  });

  const latest = q.data?.latest ?? null;
  const running = latest?.status === "running" || generate.isPending;
  // Son istek düştüyse önceki hazır liste yine de işe yarar; ama elde yalnız
  // `latest` var — düşen isteğin hatası gösterilir, liste yeniden istenir.
  const doc = latest?.status === "ready" ? latest.document : null;

  if (!canGenerate && !latest) return null;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-edge bg-surface p-4">
      <header className="flex flex-wrap items-center gap-2.5">
        <h2 className="text-[13.5px] font-semibold text-ink">Canlı test senaryoları</h2>
        {latest && (
          <span className="font-mono text-[11px] text-ink-muted">
            {STAGE_TR[latest.stage]} · {fmtClock(latest.createdAt)}
          </span>
        )}
        <span className="flex-1" />
        {canGenerate && (
          <>
            <Button variant="neutral" size="sm" disabled={running} onClick={() => setNoteOpen((v) => !v)}>
              Odak notu
            </Button>
            <Button variant="primary" size="sm" disabled={running} onClick={() => generate.mutate()}>
              {running ? "çıkarılıyor…" : latest ? "Yeniden çıkar" : "Test senaryoları çıkar"}
            </Button>
          </>
        )}
      </header>

      {canGenerate && noteOpen && (
        <Textarea
          rows={2}
          value={note}
          placeholder="İsteğe bağlı: neye ağırlık verilsin? (ör. yetki farkları, boş liste, hatalı giriş)"
          onChange={(e) => setNote(e.target.value)}
        />
      )}

      {!latest && !running && (
        <p className="text-[13px] leading-relaxed text-ink-dim">
          Uygulamayı elle test ederken izleyeceğin adımları ve beklenen sonuçları çıkarır. Plan aşamasında plandan,
          canlı testte gerçekten değişen koddan türetilir. Üretilirken onay ve sohbet bekletilir.
        </p>
      )}
      {running && (
        <p className="text-[13px] text-ink-dim">
          Senaryolar çıkarılıyor; akış sekmesinden izlenebilir. Bitene dek onay ve sohbet bekletilir.
        </p>
      )}
      {latest?.status === "failed" && !running && (
        <ErrorText error={`Senaryolar çıkarılamadı: ${latest.error || "bilinmeyen hata"}`} />
      )}
      {latest?.status === "ready" && !doc && (
        <ErrorText error="Kayıtlı senaryo belgesi okunamadı; yeniden çıkarın." />
      )}
      <ErrorText error={generate.error ?? q.error} />

      {doc && latest && !listless && <ScenarioList key={latest.id} jobId={jobId} row={latest} doc={doc} canMark={canMark} />}
      {/* İkinci göz (§42): bulgular senaryo listesinin kalitesine dair;
          red gerekçesine taşınmaz — red Developer'a gider, listeye değil. */}
      {doc && latest && <CritiqueCard jobId={jobId} subject="scenarios" subjectId={latest.id} />}
    </section>
  );
}

/**
 * Senaryolar alana göre gruplu. İşaretler SUNUCUDA: red anında "kaldı"lar
 * Developer'a gider, liste sonraki turda yeniden üretilmeden sürer. Motor red
 * anında "kaldı"ları ve aynı alandaki "geçti"leri `retest` yapar.
 */
function ScenarioList({ jobId, row, doc, canMark }: { jobId: string; row: TestScenariosRow; doc: TestScenariosDocument; canMark: boolean }) {
  const qc = useQueryClient();
  const mark = useMutation({
    mutationFn: ({ key, state, note }: { key: string; state: HumanMark | null; note: string }) =>
      api.setScenarioMark(jobId, row.id, key, state, note),
    onSuccess: ({ marks }) =>
      qc.setQueryData<TestScenariosView>(["testScenarios", jobId], (prev) =>
        prev?.latest?.id === row.id ? { ...prev, latest: { ...prev.latest, marks } } : prev,
      ),
  });
  const marks = row.marks;
  const groups = new Map<string, { s: TestScenario; key: string }[]>();
  doc.scenarios.forEach((s, i) => {
    const area = s.area || "Genel";
    groups.set(area, [...(groups.get(area) ?? []), { s, key: scenarioKey(i) }]);
  });
  const count = (st: ScenarioMarkState) => Object.values(marks).filter((m) => m.state === st).length;

  const toggle = (key: string, state: HumanMark) => {
    const cur = marks[key];
    // Aynı düğmeye ikinci basış işareti kaldırır. Durum değişirken not kalır:
    // "kaldı"dan "kararsız"a geçerken gözlem hâlâ geçerli. Agent'ın işaretinde
    // aynı düğme BENİMSER (kaynak insan olur); kaldırmak ikinci basıştır.
    const adopt = cur?.source === "agent" && cur.state === state;
    mark.mutate(cur?.state === state && !adopt ? { key, state: null, note: "" } : { key, state, note: cur?.note ?? "" });
  };
  const saveNote = (key: string, note: string) => {
    const cur = marks[key];
    if (!cur || cur.state === "retest" || cur.note === note.trim()) return;
    mark.mutate({ key, state: cur.state, note });
  };

  const retest = count("retest");
  const byAgent = Object.values(marks).filter((m) => m.source === "agent").length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 font-mono text-[11.5px] text-ink-muted">
          tur {row.round} · {doc.scenarios.length} senaryo · {count("pass")} geçti · {count("fail")} kaldı
          {count("unsure") > 0 && <> · {count("unsure")} kararsız</>}
          {retest > 0 && <> · {retest} tekrar test</>}
          {row.note && <> · odak: {row.note}</>}
        </p>
        <CopyButton doc={doc} marks={marks} />
      </div>
      {canMark && count("fail") > 0 && (
        <p className="text-[12.5px] leading-relaxed text-ink-dim">
          Reddedersen "kaldı" senaryoları adımları ve notlarıyla Developer'a gider; yorum yazmak isteğe bağlı olur.
        </p>
      )}
      {canMark && byAgent > 0 && (
        <p className="text-[12.5px] leading-relaxed text-ink-dim">
          🤖 işaretlerini tarayıcı testi koydu. Aynı düğmeye basarak benimse ya da başka düğmeyle değiştir; insan işareti
          her zaman geçerlidir.
        </p>
      )}
      <ErrorText error={mark.error} />
      {[...groups.entries()].map(([area, items]) => (
        <div key={area} className="flex flex-col gap-1.5">
          <span className="font-mono text-[10.5px] tracking-[.1em] text-ink-muted uppercase">{area}</span>
          {items.map(({ s, key }) => (
            <ScenarioItem
              key={key}
              jobId={jobId}
              s={s}
              mark={marks[key]}
              stale={(marks[key]?.round ?? row.round) < row.round}
              canMark={canMark && !mark.isPending}
              onMark={(m) => toggle(key, m)}
              onNote={(n) => saveNote(key, n)}
            />
          ))}
        </div>
      ))}
      {doc.notes && <p className="text-[12.5px] leading-relaxed text-ink-dim">Not: {doc.notes}</p>}
    </div>
  );
}

function ScenarioItem({
  jobId,
  s,
  mark,
  stale,
  canMark,
  onMark,
  onNote,
}: {
  jobId: string;
  s: TestScenario;
  mark: ScenarioMark | undefined;
  /** İşaret önceki turdan: düzeltme sonrası yeniden denenmedi. */
  stale: boolean;
  canMark: boolean;
  onMark: (m: HumanMark) => void;
  onNote: (note: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const state = mark?.state;
  const edge =
    state === "pass" ? "border-ok/50" : state === "fail" ? "border-err/50" : state === "unsure" || state === "retest" ? "border-wait/40" : "border-line";
  // Not "kaldı" ve "kararsız"da anlamlı: biri Developer'a gider, öteki nedenini saklar.
  const wantsNote = canMark && (state === "fail" || state === "unsure");
  return (
    <div className={`rounded-lg border ${edge} bg-surface px-3 py-2.5`}>
      <div className="flex flex-wrap items-start gap-2.5">
        <button onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-start gap-2 text-left">
          <span className="mt-[3px] font-mono text-[10px] text-ink-muted">{open ? "▾" : "▸"}</span>
          <span className="min-w-0">
            <span className={`block text-[13px] leading-[1.5] ${state === "pass" ? "text-ink-muted" : "text-ink"}`}>{s.title}</span>
            <span className={`font-mono text-[10.5px] ${s.priority === "high" ? "text-ink-dim" : "text-ink-muted"}`}>
              öncelik: {PRIORITY[s.priority].label}
              {s.account && <span className="text-ink-dim"> · hesap: {s.account}</span>}
            </span>
          </span>
        </button>
        {state === "retest" && <Badge value="tekrar test et" tone="wait" />}
        {mark?.source === "agent" && state !== "retest" && (
          <span title="Tarayıcı testinin ön işareti — benimse ya da değiştir" className="font-mono text-[10.5px] text-ink-muted">
            🤖 agent
          </span>
        )}
        {stale && state !== "retest" && <span className="font-mono text-[10.5px] text-ink-muted">önceki tur</span>}
        {canMark && (
          <>
            <MarkButton on={state === "pass"} tone="ok" onClick={() => onMark("pass")} label="geçti" />
            <MarkButton on={state === "fail"} tone="err" onClick={() => onMark("fail")} label="kaldı" />
            <MarkButton on={state === "unsure"} tone="wait" onClick={() => onMark("unsure")} label="kararsız" />
          </>
        )}
        {!canMark && state && state !== "retest" && <span className="font-mono text-[11px] text-ink-muted">{MARK_TR[state]}</span>}
      </div>
      {wantsNote && (
        <input
          key={`${state}:${mark?.note ?? ""}`}
          defaultValue={mark?.note ?? ""}
          onBlur={(e) => onNote(e.target.value)}
          placeholder={state === "fail" ? "Ne oldu? (Developer'a gider)" : "Neden kararsız? (tutarsız sonuç / senaryo yanlış)"}
          className="mt-2 ml-5 w-[calc(100%-1.25rem)] rounded-md border border-edge bg-surface px-2 py-1 text-[12.5px] text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
        />
      )}
      {!wantsNote && mark?.note && (
        <p className="mt-1.5 pl-5 text-[12px] leading-relaxed text-ink-dim">
          {state === "retest" ? "Önceki turdaki gözlem: " : "Not: "}
          {mark.note}
        </p>
      )}
      {mark && mark.evidence.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2 pl-5">
          {mark.evidence.map((ref, i) => (
            <button key={ref} type="button" onClick={() => setViewing(i)} title={ref}>
              <img
                src={api.liveEvidenceUrl(jobId, ref)}
                alt={`kanıt ${ref}`}
                loading="lazy"
                className="h-20 w-auto rounded-md border border-edge object-cover hover:border-accent"
              />
            </button>
          ))}
        </div>
      )}
      {viewing !== null && mark && mark.evidence.length > 0 && (
        <EvidenceModal jobId={jobId} s={s} mark={mark} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} />
      )}
      {open && (
        <div className="mt-2 flex flex-col gap-2 pl-5 text-[12.5px] leading-[1.6] text-ink-body">
          {s.preconditions.length > 0 && (
            <div>
              <span className="font-semibold text-ink">Ön koşul</span>
              <ul className="ml-4 list-disc">
                {s.preconditions.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <span className="font-semibold text-ink">Adımlar</span>
            <ol className="ml-4 list-decimal">
              {s.steps.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ol>
          </div>
          <div>
            <span className="font-semibold text-ink">Beklenen</span>
            <p className="whitespace-pre-line">{s.expected}</p>
          </div>
          {s.covers.length > 0 && (
            <div>
              <span className="font-semibold text-ink">Doğruladığı gereksinimler</span>
              <p className="font-mono text-[11.5px]">{s.covers.join(", ")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const MARK_TONE: Record<ScenarioMarkState, Tone> = { pass: "ok", fail: "err", unsure: "wait", retest: "wait" };

/**
 * Kanıt görüntüsü senaryosuyla yan yana. Yeni sekmede açılan görüntüde hangi
 * senaryonun hangi adımı olduğu ve agent'ın ne dediği kayboluyordu; insan
 * işareti benimserken ikisini birlikte görmeli. `←`/`→` görüntüler arasında.
 */
function EvidenceModal({
  jobId,
  s,
  mark,
  index,
  onIndex,
  onClose,
}: {
  jobId: string;
  s: TestScenario;
  mark: ScenarioMark;
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const refs = mark.evidence;
  const i = Math.min(index, refs.length - 1);
  const ref = refs[i] ?? "";
  const go = (d: number) => onIndex((i + d + refs.length) % refs.length);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && refs.length > 1) onIndex((i + 1) % refs.length);
      else if (e.key === "ArrowLeft" && refs.length > 1) onIndex((i - 1 + refs.length) % refs.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i, refs.length, onIndex, onClose]);

  return (
    <Modal title={s.title} subtitle={[s.area, s.account && `hesap: ${s.account}`, `öncelik: ${PRIORITY[s.priority].label}`].filter(Boolean).join(" · ")} onClose={onClose} width={1200}>
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="relative flex items-center justify-center rounded-lg border border-edge bg-sunken">
            <a href={api.liveEvidenceUrl(jobId, ref)} target="_blank" rel="noreferrer" title="Tam boyut, yeni sekmede">
              <img src={api.liveEvidenceUrl(jobId, ref)} alt={`kanıt ${ref}`} className="max-h-[65vh] w-auto object-contain" />
            </a>
            {refs.length > 1 && (
              <>
                <NavButton side="left" onClick={() => go(-1)} />
                <NavButton side="right" onClick={() => go(1)} />
              </>
            )}
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px] text-ink-muted">
            <span className="min-w-0 flex-1 truncate">{ref}</span>
            {refs.length > 1 && <span>{i + 1} / {refs.length}</span>}
          </div>
          {refs.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {refs.map((r, j) => (
                <button key={r} type="button" onClick={() => onIndex(j)} title={r}>
                  <img
                    src={api.liveEvidenceUrl(jobId, r)}
                    alt={`kanıt ${r}`}
                    loading="lazy"
                    className={`h-14 w-auto rounded-md border object-cover ${j === i ? "border-accent" : "border-edge opacity-70 hover:opacity-100"}`}
                  />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex w-full shrink-0 flex-col gap-3 text-[12.5px] leading-[1.6] text-ink-body lg:w-[340px]">
          <div className="flex flex-wrap items-center gap-2">
            <Badge value={MARK_TR[mark.state]} tone={MARK_TONE[mark.state]} />
            {mark.source === "agent" && <span className="font-mono text-[10.5px] text-ink-muted">🤖 agent</span>}
            <span className="font-mono text-[10.5px] text-ink-muted">tur {mark.round}</span>
          </div>
          {mark.note && (
            <div>
              <span className="font-semibold text-ink">Not</span>
              <p className="whitespace-pre-line">{mark.note}</p>
            </div>
          )}
          {s.preconditions.length > 0 && (
            <div>
              <span className="font-semibold text-ink">Ön koşul</span>
              <ul className="ml-4 list-disc">
                {s.preconditions.map((p, j) => (
                  <li key={j}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <span className="font-semibold text-ink">Adımlar</span>
            <ol className="ml-4 list-decimal">
              {s.steps.map((p, j) => (
                <li key={j}>{p}</li>
              ))}
            </ol>
          </div>
          <div>
            <span className="font-semibold text-ink">Beklenen</span>
            <p className="whitespace-pre-line">{s.expected}</p>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function NavButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "önceki görüntü" : "sonraki görüntü"}
      className={`absolute top-1/2 -translate-y-1/2 ${side === "left" ? "left-2" : "right-2"} flex h-9 w-9 items-center justify-center rounded-full border border-edge bg-surface/90 font-mono text-[15px] text-ink shadow hover:bg-raised`}
    >
      {side === "left" ? "‹" : "›"}
    </button>
  );
}

const MARK_ON = {
  ok: "border-ok/40 bg-ok/12 text-ok-ink",
  err: "border-err/40 bg-err/12 text-err-ink",
  wait: "border-wait/40 bg-wait/12 text-wait-ink",
} as const;

function MarkButton({ on, tone, onClick, label }: { on: boolean; tone: keyof typeof MARK_ON; onClick: () => void; label: string }) {
  const cls = on ? MARK_ON[tone] : "border-edge text-ink-muted hover:bg-sunken";
  return (
    <button onClick={onClick} className={`shrink-0 rounded-md border px-2 py-0.5 font-mono text-[11px] ${cls}`}>
      {label}
    </button>
  );
}

/** Markdown olarak panoya — issue'ya, test notuna ya da red yorumuna yapıştırmak için. */
function CopyButton({ doc, marks }: { doc: TestScenariosDocument; marks: ScenarioMarks }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    const md = doc.scenarios
      .map((s, i) =>
        [
          `### ${i + 1}. ${s.title}${s.area ? ` (${s.area})` : ""} — ${PRIORITY[s.priority].label}${markText(marks[scenarioKey(i)])}`,
          ...(s.account ? [`**Hesap:** ${s.account}`] : []),
          ...(s.preconditions.length ? ["**Ön koşul:**", ...s.preconditions.map((p) => `- ${p}`)] : []),
          "**Adımlar:**",
          ...s.steps.map((p, j) => `${j + 1}. ${p}`),
          `**Beklenen:** ${s.expected}`,
          ...(s.covers.length ? [`**Gereksinim:** ${s.covers.join(", ")}`] : []),
        ].join("\n"),
      )
      .join("\n\n");
    void navigator.clipboard
      .writeText(md)
      .then(() => {
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <Button variant="neutral" size="sm" onClick={copy}>
      {done ? "kopyalandı" : "Markdown kopyala"}
    </Button>
  );
}
