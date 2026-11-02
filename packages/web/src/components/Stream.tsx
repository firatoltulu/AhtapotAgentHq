import { useEffect, useRef, useState } from "react";

import type { ServerEvent } from "@ahtapot/shared";

import { fmtClock, fmtDuration, fmtUsd } from "../ui";
import { parseBlock, splitMessage } from "./agentBlocks";
import { GROUP_LABELS, type StreamGroup } from "./streamGroups";
import { commandLabel, exitHint, toolView, type Tone } from "./toolView";

/**
 * Canlı olay akışı — zaman çizgisi.
 *
 * ESKİDEN kart yığınıydı: her olay aynı görünen bir kutu, `Edit` satırı ham
 * JSON basıyor (`{"replace_all":false,"file_path":…,"old_string":"…`), tek
 * satıra sığmadığı için kesiliyordu. Komut kartıyla dosya kartı ayırt
 * edilemiyor, operatör "ne oldu"yu okumak için JSON ayrıştırmak zorunda
 * kalıyordu.
 *
 * Şimdi tek bir zaman çizgisi: solda nokta + dikey bağlantı, sağda olay
 * tipine göre FARKLI çizilen gövde. Ham argüman JSON'u hiçbir tonda geçmez.
 */

/** Zaman çizgisi noktasının rengi — tona göre. */
const DOT_TONES: Record<Tone, string> = {
  meta: "#0b7c63",
  think: "#7d67e8",
  read: "#8b9c95",
  edit: "#4a68b8",
  cmd: "#5b6e67",
  msg: "#16241e",
  gate: "#5a37e0",
};

/** Başlıktaki araç etiketinin rengi — çip değil, düz renkli metin. */
const LABEL_TONES: Record<Tone, string> = {
  meta: "text-brand-ink",
  think: "text-[#4a33a8]",
  read: "text-ink-muted",
  edit: "text-[#39538f]",
  cmd: "text-ink-body",
  msg: "text-ink",
  gate: "text-accent-ink",
};

/** Anlatı gövdesinin rengi. */
const BODY_TONES: Record<Tone, string> = {
  meta: "text-ink-body",
  think: "text-[#52469a]",
  read: "text-ink-body",
  edit: "text-ink-body",
  cmd: "text-ink-body",
  msg: "text-ink-body",
  gate: "text-ink-body",
};

/** 4 satırdan uzun fark kırpılır; gerisi açılabilir. */
const DIFF_HEAD = 4;
/** 8 satırdan uzun çıktı kırpılır. */
const OUT_HEAD = 8;

export function StreamRow({
  e,
  result,
  last = false,
  children,
}: {
  e: ServerEvent;
  /** Bu çağrının sonucu — yalnız araç satırı çizilirken verilir. */
  result?: Extract<ServerEvent, { type: "agent.tool_result" }> | undefined;
  /** Son satırda dikey bağlantı çizgisi çizilmez. */
  last?: boolean;
  children?: React.ReactNode;
}) {
  const v = toolView(e);
  const exitCode = result?.exitCode;
  // exit ≠ 0 ise nokta kırmızı: kırık komut akışta gözden kaçmamalı.
  const failed =
    e.type === "job.error" ||
    (e.type === "agent.tool_result" && !e.ok) ||
    (result !== undefined && (!result.ok || (exitCode !== undefined && exitCode !== 0)));

  const dot = failed ? "#a3241a" : DOT_TONES[v.tone];

  return (
    <div className="flex gap-[13px]">
      {/* Sol ray: nokta + altında bağlantı çizgisi. */}
      <div className="flex w-[9px] shrink-0 flex-col items-center">
        <span
          className="mt-[5px] h-[9px] w-[9px] shrink-0 rounded-full"
          style={{ background: dot, boxShadow: `0 0 0 3px ${dot}22` }}
        />
        {!last && <span className="w-px flex-1 bg-[#dfe6e2]" />}
      </div>

      <div className={`flex min-w-0 flex-1 flex-col gap-2 ${last ? "" : "pb-5"}`}>
        <div className="flex flex-wrap items-center gap-2.5">
          <span
            className={`font-mono text-[10.5px] font-semibold uppercase tracking-[.07em] ${
              failed ? "text-err-text" : LABEL_TONES[v.tone]
            }`}
          >
            {v.label}
          </span>
          {v.actor && <span className="font-mono text-[10.5px] text-ink-muted">{v.actor}</span>}
          <span className="flex-1" />
          <span className="font-mono text-[10.5px] text-gutter">
            {fmtClock(e.at)}
            {e.seq > 0 && ` · seq ${e.seq}`}
          </span>
        </div>

        <Body e={e} view={v} result={result} />
        {children}
      </div>
    </div>
  );
}

/** Olay tipine göre gövde — tonun karşılığı ne ise o çizilir. */
function Body({
  e,
  view: v,
  result,
}: {
  e: ServerEvent;
  view: ReturnType<typeof toolView>;
  result?: Extract<ServerEvent, { type: "agent.tool_result" }> | undefined;
}) {
  if (v.tone === "cmd" && v.command) return <CommandBody view={v} result={result} />;
  if ((v.tone === "read" || v.tone === "edit") && (v.file || v.dir)) return <FileBody view={v} />;

  // agent.end ve cost.update gövdesi ölçüdür; metin yerine çip olarak okunur.
  if (e.type === "agent.end") {
    return (
      <Chips
        items={[e.subtype, `${e.numTurns} tur`, fmtUsd(e.costMicroUsd), fmtDuration(e.durationMs)]}
      />
    );
  }
  if (e.type === "cost.update") return <Chips items={[`toplam ${fmtUsd(e.totalMicroUsd)}`]} />;

  if (!v.text) return null;
  if (v.tone === "msg") return <MessageText text={v.text} />;
  return (
    <p className={`aht-wrap max-w-[82ch] text-[13.5px] leading-[1.65] text-pretty ${BODY_TONES[v.tone]}`}>
      {v.text}
    </p>
  );
}

/** Agent mesajı: anlatı paragraf olarak, `*_JSON` blokları katlı düğme olarak. */
function MessageText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const parts = splitMessage(text);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <p key={i} className="aht-wrap max-w-[82ch] text-[13.5px] leading-[1.65] text-pretty text-ink-body">
            {p.text}
            {streaming && i === parts.length - 1 && <span className="aht-pulse ml-0.5 inline-block">▍</span>}
          </p>
        ) : (
          <BlockChip key={i} name={p.name} raw={p.raw} pending={p.pending} />
        ),
      )}
    </div>
  );
}

/** Makine bloğu — kapalıyken tek satır, açılınca alan alan. */
function BlockChip({ name, raw, pending }: { name: string; raw: string; pending: boolean }) {
  const [open, setOpen] = useState(false);
  if (pending) {
    return (
      <span className="aht-pulse self-start rounded-[6px] border border-edge bg-raised px-2 py-1 font-mono text-[11px] text-ink-muted">
        {name} yazılıyor…
      </span>
    );
  }
  const data = parseBlock(raw);
  const fields = data && typeof data === "object" && !Array.isArray(data) ? Object.entries(data) : null;
  const filled = fields?.filter(([, v]) => !(Array.isArray(v) && v.length === 0) && v !== "" && v !== null) ?? [];

  return (
    <div className="flex max-w-[82ch] min-w-0 flex-col self-stretch">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 self-start rounded-[6px] border border-edge bg-raised px-2 py-1 font-mono text-[11px] text-ink-muted hover:text-ink"
      >
        <span>{open ? "▾" : "▸"}</span>
        <span className="font-semibold text-ink">{name}</span>
        <span>{fields ? `${filled.length} alan` : "biçimsiz"}</span>
      </button>
      {open &&
        (fields ? (
          <dl className="mt-1.5 flex flex-col gap-2 rounded-[9px] border border-edge bg-surface px-3 py-2.5">
            {filled.map(([k, v]) => (
              <div key={k} className="flex min-w-0 flex-col gap-0.5">
                <dt className="font-mono text-[10.5px] font-semibold uppercase tracking-[.05em] text-ink-muted">{k}</dt>
                <dd className="min-w-0">
                  <BlockValue value={v} />
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <pre className="aht-wrap mt-1.5 rounded-[9px] border border-edge bg-surface px-3 py-2.5 font-mono text-[11.5px] text-ink-body">
            {raw}
          </pre>
        ))}
    </div>
  );
}

/** Dize listesi madde olarak; iç içe yapı girintili JSON olarak. */
function BlockValue({ value }: { value: unknown }) {
  if (Array.isArray(value) && value.every((x) => typeof x === "string")) {
    return (
      <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[12.5px] leading-[1.55] text-ink-body">
        {value.map((x, i) => (
          <li key={i} className="aht-wrap">
            {x}
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <p className="aht-wrap text-[12.5px] leading-[1.55] text-ink-body">{String(value)}</p>;
  }
  return (
    <pre className="aht-wrap font-mono text-[11.5px] leading-[1.55] text-ink-body">{JSON.stringify(value, null, 2)}</pre>
  );
}

/** Dosya satırı: yol + not + ölçü çipleri; `edit` ise ayrıca mini fark. */
function FileBody({ view: v }: { view: ReturnType<typeof toolView> }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="aht-wrap min-w-0">
        {v.dir && <span className="font-mono text-[12px] text-ink-muted">{v.dir}</span>}
        <span className="font-mono text-[12.5px] font-semibold text-ink">{v.file}</span>
      </div>
      {v.text && <p className="aht-wrap max-w-[82ch] text-[12.5px] text-ink-body">{v.text}</p>}
      {v.diff.length > 0 && <MiniDiff diff={v.diff} />}
      <Chips items={v.meta} />
    </div>
  );
}

/**
 * Mini fark kutusu — `old_string`/`new_string` ham JSON olarak ASLA basılmaz.
 *
 * Fark sunucudan satır satır gelir (`agent.tool_use.diff`); istemci
 * `inputSummary`den kuramaz çünkü o 200 karakterde kesiliyor.
 */
function MiniDiff({ diff }: { diff: [("-" | "+"), string][] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? diff : diff.slice(0, DIFF_HEAD);
  const rest = diff.length - shown.length;

  return (
    <div className="flex max-w-[82ch] flex-col overflow-hidden rounded-[9px] border border-edge bg-surface">
      {shown.map(([mark, text], i) => (
        <div
          key={`${i}-${mark}`}
          className={`flex gap-2 px-2.5 py-[3px] ${mark === "-" ? "bg-[#fdf4f3]" : "bg-[#f0f8f1]"}`}
        >
          <span
            className={`shrink-0 font-mono text-[11.5px] font-semibold ${
              mark === "-" ? "text-err-ink" : "text-build-mark"
            }`}
          >
            {mark === "-" ? "−" : "+"}
          </span>
          <span className="aht-wrap min-w-0 flex-1 font-mono text-[11.5px] leading-[1.6] text-[#2b3a34]">
            {text}
          </span>
        </div>
      ))}
      {rest > 0 && (
        <button
          onClick={() => setOpen(true)}
          className="border-t border-edge bg-raised px-2.5 py-1.5 text-left font-mono text-[10.5px] text-ink-muted hover:text-ink"
        >
          {rest} satır daha
        </button>
      )}
    </div>
  );
}

/**
 * Komut gövdesi — amaç, komut kutusu, çıktı, ipucu.
 *
 * Komut ve sonucu telde iki ayrı olay (`agent.tool_use` → `agent.tool_result`);
 * burada tek gövdede birleşir çünkü operatör ikisini ayrı satırda okuyunca
 * hangi çıktının hangi komuta ait olduğunu izleyemiyordu.
 *
 * Komut ASLA yatay kesilmez: `pre-wrap` + `word-break` ile sarılır. Uzun bir
 * `dotnet test --filter …` satırının sonu ekranın dışında kalıyordu.
 */
function CommandBody({
  view: v,
  result,
}: {
  view: ReturnType<typeof toolView>;
  result?: Extract<ServerEvent, { type: "agent.tool_result" }> | undefined;
}) {
  const pending = result === undefined;
  const exitCode = result?.exitCode;
  const failed = result !== undefined && (!result.ok || (exitCode !== undefined && exitCode !== 0));
  const hint = result ? exitHint(exitCode, result.ok) : "";

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {/* Amaç satırı: ne koşuyor + çıkış + süre + dizin. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-ink">{commandLabel(v.command)}</span>
        {pending ? (
          <span className="aht-pulse rounded-[5px] bg-chip px-[7px] py-0.5 font-mono text-[10.5px] font-semibold text-ink-muted">
            koşuyor
          </span>
        ) : (
          <span
            className={`rounded-[5px] px-[7px] py-0.5 font-mono text-[10.5px] font-semibold ${
              failed ? "bg-err-edge/45 text-err-text" : "bg-brand-tint-soft text-brand-ink"
            }`}
          >
            {exitCode !== undefined ? `exit ${exitCode}` : result.ok ? "ok" : "hata"}
          </span>
        )}
        {result?.durationMs !== undefined && (
          <span className="font-mono text-[10.5px] text-ink-muted">{fmtDuration(result.durationMs)}</span>
        )}
        {v.cwd && (
          <span className="aht-wrap min-w-0 font-mono text-[10.5px] text-ink-muted" title={v.cwd}>
            {v.cwd}
          </span>
        )}
      </div>

      {/* Komut kutusu — sol çizgi, `$`, sarılan komut. */}
      <div
        className={`flex max-w-[82ch] items-start gap-2 rounded-[9px] border-l-2 px-3 py-2.5 ${
          failed ? "border-l-[#d9a49c] bg-[#fdf5f3]" : "border-l-[#c9d5cf] bg-[#f4f7f5]"
        }`}
      >
        <span className="shrink-0 font-mono text-[12px] font-semibold text-brand">$</span>
        <span className="aht-wrap min-w-0 flex-1 font-mono text-[12px] leading-[1.55] text-ink">{v.command}</span>
      </div>

      {result && result.summary && <CommandOut text={result.summary} failed={failed} />}

      {hint && <p className={`text-[12.5px] ${failed ? "text-err-text" : "text-ink-body"}`}>{hint}</p>}
    </div>
  );
}

/** Komut çıktısı — kutunun dışında, kesikli sol çizgi ile. */
function CommandOut({ text, failed }: { text: string; failed: boolean }) {
  const [open, setOpen] = useState(false);
  const all = text.split("\n");
  const shown = open ? all : all.slice(0, OUT_HEAD);
  const rest = all.length - shown.length;

  return (
    <div className="ml-1 flex max-w-[82ch] flex-col gap-0.5 border-l border-dashed border-edge-strong pl-[13px]">
      {shown.map((line, i) => (
        <span
          key={i}
          className={`aht-wrap font-mono text-[11.5px] leading-[1.6] ${
            failed ? "font-medium text-err-ink" : "text-ink-body"
          }`}
        >
          {line}
        </span>
      ))}
      {rest > 0 && (
        <button
          onClick={() => setOpen(true)}
          className="self-start pt-1 font-mono text-[10.5px] text-ink-muted hover:text-ink"
        >
          {rest} satır daha
        </button>
      )}
    </div>
  );
}

/** Ölçü çipleri — mono, yalnız yol/komut/seq/meta için. */
function Chips({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((c, i) => (
        <span
          key={`${c}-${i}`}
          className="rounded-[5px] border border-[#e6ebe8] bg-[#f1f4f2] px-[7px] py-0.5 font-mono text-[10.5px] text-ink-muted"
        >
          {c}
        </span>
      ))}
    </div>
  );
}

/** Akış filtre şeridi — grup başına sayaçlı. */
export function StreamFilters({
  active,
  counts,
  onPick,
}: {
  active: StreamGroup | "all";
  counts: Record<StreamGroup | "all", number>;
  onPick: (g: StreamGroup | "all") => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-[7px]">
      {GROUP_LABELS.map((g) => {
        const on = active === g.key;
        return (
          <button
            key={g.key}
            onClick={() => onPick(g.key)}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-[5px] text-[12px] transition-colors ${
              on
                ? "border-brand-edge bg-brand-tint font-semibold text-brand-ink"
                : "border-edge-strong bg-surface font-medium text-ink-muted hover:text-ink"
            }`}
          >
            {g.label}
            <span
              className={`rounded-[4px] px-[5px] py-px font-mono text-[10px] ${
                on ? "bg-[#d5ece3] text-brand-ink" : "bg-chip text-ink-muted"
              }`}
            >
              {counts[g.key]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Akan token'lar — tamamlanmış mesaj gelince yerini ona bırakır. */
export function DeltaRow({ text }: { text: string }) {
  return (
    <div className="flex gap-[13px]">
      <div className="flex w-[9px] shrink-0 flex-col items-center">
        <span
          className="mt-[5px] h-[9px] w-[9px] shrink-0 rounded-full"
          style={{ background: DOT_TONES.msg, boxShadow: `0 0 0 3px ${DOT_TONES.msg}22` }}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[.07em] text-run-ink">
          yazıyor
        </span>
        <MessageText text={text} streaming />
      </div>
    </div>
  );
}

/**
 * Akış dibe yapışık kalır — insan YUKARI kaydırınca bırakır, dibe dönünce
 * yeniden yapışır.
 *
 * Eskiden yalnız `deps` değişince kaydırıyor ve yapışıklığı her kaydırma
 * olayında mesafeden yeniden hesaplıyordu; akış takibi kendiliğinden
 * bırakıyordu (yaşandı):
 * - içerik `deps` dışında da büyür (akan metin, açılan blok, geç render) ve
 *   kimse kaydırmazdı;
 * - büyüme 80 pikseli aşınca tarayıcının ürettiği kaydırma olayı (scroll
 *   anchoring) insan kaydırmamışken bağı koparırdı;
 * - kutu ilk açılışta "akış boş" yüzünden render edilmiyor; `useRef` + boş
 *   bağımlılıklı effect sonradan bağlanan elemanı hiç görmezdi — bu yüzden
 *   callback ref.
 */
export function useAutoScroll(deps: unknown[]) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const lastTop = useRef(0);

  const toBottom = (node: HTMLDivElement) => {
    node.scrollTop = node.scrollHeight;
    lastTop.current = node.scrollTop;
  };

  const onScroll = () => {
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) pinned.current = true;
    // Yalnız yukarı hareket bağı koparır; içerik büyürken gelen olay koparmaz.
    else if (el.scrollTop < lastTop.current) pinned.current = false;
    lastTop.current = el.scrollTop;
  };

  useEffect(() => {
    if (el && pinned.current) toBottom(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, ...deps]);

  useEffect(() => {
    if (!el) return;
    const follow = () => {
      if (pinned.current) toBottom(el);
    };
    const mo = new MutationObserver(follow);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    // Kutunun kendi boyu değişince de (pencere, panel) dipte kalsın.
    const ro = new ResizeObserver(follow);
    ro.observe(el);
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [el]);

  return { ref: setEl, onScroll };
}
