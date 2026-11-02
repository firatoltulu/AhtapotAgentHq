import { Fragment, useMemo, useState, type ReactNode } from "react";

import { fmtAge, useLocalState } from "../ui";
import { parseDiff, splitRows, type DiffFile, type DiffLine } from "./parseDiff.js";

/**
 * Git diff görüntüleyici: dosya ağacı ve birleşik ya da yan yana kod paneli.
 *
 * Ayrıştırma `parseDiff.ts` içinde (testli); burada yalnız sunum var. "Görüldü"
 * ve satır yorumları çağıranın durumudur. Dikkat yuvası da onları okuyor
 * (görülmeyen dosya sayısı, red gerekçesine eklenecek yorumlar), o yüzden
 * burada saklanmaz.
 */

/** Operatörün bir satıra düştüğü not. Reddedilirse red gerekçesine eklenir. */
export interface LineComment {
  path: string;
  line: number;
  text: string;
  at: string;
}

/** Ekranda `M/A/D`. Ayrıştırıcının `+`/`−` işaretleri durum harfiyle karışıyordu. */
const MARKS: Record<DiffFile["mark"], { label: string; ink: string }> = {
  M: { label: "M", ink: "text-wait-ink" },
  "+": { label: "A", ink: "text-brand-ink" },
  "−": { label: "D", ink: "text-err-ink" },
};

const UNIFIED: Record<Exclude<DiffLine["kind"], "hunk">, { bg: string; gut: string; sign: string; ink: string }> = {
  add: { bg: "bg-diff-add", gut: "bg-diff-add-gutter", sign: "+", ink: "text-brand-ink" },
  del: { bg: "bg-diff-del", gut: "bg-diff-del-gutter", sign: "−", ink: "text-err-ink" },
  ctx: { bg: "bg-surface", gut: "bg-pane", sign: "", ink: "" },
};

type Mode = "split" | "unified";

export function DiffView({
  patch,
  untracked = [],
  truncated = false,
  seen,
  onSeen,
  comments = [],
  onComments,
  header,
  footer,
}: {
  patch: string;
  untracked?: string[];
  truncated?: boolean;
  /** Görüldü işaretli dosya yolları. */
  seen: string[];
  onSeen: (path: string, on: boolean) => void;
  comments?: LineComment[];
  /** Verilmezse satır yorumu yazılamaz (canlı ağaçta yorumun gideceği bir red yok). */
  onComments?: (next: LineComment[]) => void;
  /** Ağaç panelinin tepesi: kaynak seçimi (onay anı / canlı ağaç). */
  header?: ReactNode;
  /** Ağaç panelinin dibi: devir notu ve build özeti. */
  footer?: ReactNode;
}) {
  const files = useMemo(() => parseDiff(patch), [patch]);
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useLocalState<Mode>("aht.diffMode", "split");
  const [tree, setTree] = useLocalState("aht.diffTree", true);
  const [draft, setDraft] = useState<{ line: number; text: string } | null>(null);
  // TEK sınırlandırılmış indeks: içerik `active`i, düğme stili ham `sel`i
  // kullansaydı dosya sayısı azaldığında içerik görünür ama hiçbir düğme
  // seçili görünmezdi.
  const selectedIndex = Math.min(sel, files.length - 1);
  const active = files[selectedIndex];

  const totals = files.reduce((a, f) => ({ added: a.added + f.added, removed: a.removed + f.removed }), { added: 0, removed: 0 });
  const seenSet = new Set(seen);
  const seenCount = files.filter((f) => seenSet.has(f.path)).length;
  const hidden = untracked.filter((u) => !files.some((f) => f.path === u));

  if (files.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header && <div className="shrink-0 border-b border-edge bg-pane px-3.5 py-3">{header}</div>}
        <div className="m-4 rounded-xl border border-edge bg-raised px-4 py-6 text-center text-[13px] text-ink-dim">
          {/* Eskiden burada "değişiklik yok" yazıp ALTINDA yeni dosyaları
              listeliyordu: insanın onaylayacağı kodu göstermeyen çelişkili bir
              kapı. Yeni dosyalar artık patch'e giriyor; buraya düşmek gerçekten
              hiçbir şeyin değişmediği anlamına gelir. */}
          {untracked.length > 0 ? (
            <>
              Yeni dosyalar var ama içerikleri okunamadı.
              <div className="mt-2 font-mono text-[11.5px]">{untracked.join(", ")}</div>
            </>
          ) : (
            "Bu safhada değişiklik yok."
          )}
        </div>
        {footer && <div className="min-h-0 overflow-auto border-t border-edge">{footer}</div>}
      </div>
    );
  }

  const select = (i: number): void => {
    setSel(i);
    setDraft(null);
  };

  const fileComments = active ? comments.filter((c) => c.path === active.path) : [];
  const commentsAt = (line: number): LineComment[] => fileComments.filter((c) => c.line === line);
  const canComment = onComments !== undefined && active !== undefined;
  const openDraft = (line: number): void => {
    if (canComment) setDraft({ line, text: "" });
  };
  const saveDraft = (): void => {
    if (!draft || !active || !onComments || !draft.text.trim()) return;
    onComments([...comments, { path: active.path, line: draft.line, text: draft.text.trim(), at: new Date().toISOString() }]);
    setDraft(null);
  };
  const removeComment = (c: LineComment): void => {
    onComments?.(comments.filter((x) => x !== c));
  };

  /** Satırın altına düşen yorum kartları ve (varsa) taslak. */
  const threadFor = (line: number | null, split: boolean): ReactNode => {
    if (line === null) return null;
    const list = commentsAt(line);
    const drafting = draft?.line === line;
    if (list.length === 0 && !drafting) return null;
    const cards = (
      <div className="flex flex-col gap-2 font-sans">
        {list.map((c) => (
          <CommentCard key={c.at} comment={c} onRemove={onComments ? () => removeComment(c) : undefined} />
        ))}
        {drafting && draft && (
          <DraftCard
            line={line}
            text={draft.text}
            onText={(text) => setDraft({ line, text })}
            onCancel={() => setDraft(null)}
            onSave={saveDraft}
          />
        )}
      </div>
    );
    return split ? (
      <div className="grid grid-cols-2 border-y border-accent-edge-soft bg-accent-wash">
        <div />
        <div className="border-l border-edge py-2 pb-2.5 pl-14 pr-3.5">{cards}</div>
      </div>
    ) : (
      <div className="border-y border-accent-edge-soft bg-accent-wash py-2 pb-2.5 pl-[106px] pr-4.5">{cards}</div>
    );
  };

  /** Yeni satır numarası: yorum yazılabiliyorsa tıklanır. */
  const newNo = (no: number | null, className: string): ReactNode =>
    canComment && no !== null ? (
      <button
        type="button"
        onClick={() => openDraft(no)}
        title="Bu satıra yorum ekle"
        className={`cursor-pointer select-none pr-[7px] text-right text-line-no hover:bg-accent-tint! hover:text-accent-ink ${className}`}
      >
        {no}
      </button>
    ) : (
      <span className={`select-none pr-[7px] text-right text-line-no ${className}`}>{no ?? ""}</span>
    );

  return (
    <div
      className={`grid h-full min-h-0 grid-cols-1 ${
        tree ? "grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)] lg:grid-rows-1" : "grid-rows-1"
      }`}
    >
      {/* Ağaç kapalıyken dar ekranda da gizlenir: aç/kapa düğmesi araç çubuğunda. */}
      {tree && (
        <div className="flex min-h-0 min-w-0 flex-col border-edge bg-pane max-lg:max-h-[40vh] max-lg:border-b lg:border-r">
          <div className="flex shrink-0 flex-col gap-2 border-b border-edge px-3.5 py-3">
            {header}
            <div className="flex items-center gap-2 font-mono text-[11px] text-ink-muted">
              <span>{files.length} dosya</span>
              <span className="text-brand-ink">+{totals.added}</span>
              <span className="text-err-ink">−{totals.removed}</span>
              <span className="flex-1" />
              <span className={seenCount < files.length ? "text-wait-ink" : "text-brand-ink"}>
                {seenCount}/{files.length} görüldü
              </span>
            </div>
            {truncated && (
              <span className="self-start rounded-[5px] bg-wait-tint px-2 py-0.5 font-mono text-[10.5px] text-wait-ink">
                diff kesildi — tamamı için worktree'ye bak
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-1.5">
            {files.map((f, i) => {
              const name = f.path.split("/").pop() ?? f.path;
              const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, "");
              const on = i === selectedIndex;
              const isSeen = seenSet.has(f.path);
              const count = comments.filter((c) => c.path === f.path).length;
              return (
                <div
                  key={f.path}
                  className={`flex items-center gap-2 rounded-lg pl-2 transition-colors ${
                    on ? "bg-brand-tint shadow-[inset_2px_0_0_var(--color-brand)]" : "hover:bg-chip"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSeen(f.path, !isSeen)}
                    title={isSeen ? "Görülmedi olarak işaretle" : "Görüldü olarak işaretle"}
                    aria-label={isSeen ? "Görülmedi olarak işaretle" : "Görüldü olarak işaretle"}
                    aria-pressed={isSeen}
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] text-white ${
                      isSeen ? "border-brand bg-brand" : "border-wait-edge bg-surface"
                    }`}
                  >
                    {isSeen ? "✓" : ""}
                  </button>
                  <button
                    type="button"
                    onClick={() => select(i)}
                    className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-2 text-left"
                  >
                    <span className={`shrink-0 font-mono text-[10.5px] font-semibold ${MARKS[f.mark].ink}`}>
                      {MARKS[f.mark].label}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-px">
                      <span className="truncate font-mono text-[11.5px] text-ink">{name}</span>
                      {dir && <span className="truncate font-mono text-[10px] text-ink-faint">{dir}</span>}
                    </span>
                    {count > 0 && (
                      <span className="shrink-0 rounded bg-accent-tint px-[5px] py-px font-mono text-[10px] text-accent-ink">
                        {count} yorum
                      </span>
                    )}
                    <span className="shrink-0 font-mono text-[10.5px] text-brand-ink">+{f.added}</span>
                    <span className="shrink-0 font-mono text-[10.5px] text-err-ink">−{f.removed}</span>
                  </button>
                </div>
              );
            })}
            {/* İzlenmeyen dosyalar ARTIK yukarıdaki listede: `diffSummary` onları
                `--no-index` ile patch'e katıyor. Listede görünmeyen kalırsa (ikili
                dosya, okunamayan yol) burada anılır, sessizce düşmesin. */}
            {hidden.length > 0 && (
              <div className="mt-1.5 border-t border-edge px-2.5 pt-2 font-mono text-[10.5px] leading-relaxed text-ink-muted">
                içeriği gösterilemeyen yeni dosyalar: {hidden.join(", ")}
              </div>
            )}
          </div>

          {footer && <div className="max-h-[45%] shrink-0 overflow-auto border-t border-edge">{footer}</div>}
        </div>
      )}

      {active && (
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-edge bg-raised py-2.5 pl-3 pr-4.5">
            <button
              type="button"
              onClick={() => setTree((v) => !v)}
              title="Dosya listesini aç/kapat"
              aria-expanded={tree}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-edge-strong bg-surface px-[9px] text-[12px] text-ink-muted hover:text-ink"
            >
              <span className="text-[13px]">{tree ? "«" : "»"}</span>
              {!tree && `${files.length} dosya · ${seenCount}/${files.length}`}
            </button>
            <span className="min-w-0 truncate font-mono text-[12px] font-medium text-ink" title={active.path}>
              {active.path}
            </span>
            <span className="shrink-0 font-mono text-[10.5px] text-brand-ink">+{active.added}</span>
            <span className="shrink-0 font-mono text-[10.5px] text-err-ink">−{active.removed}</span>
            <span className="flex-1" />
            <span className="flex shrink-0 rounded-lg border border-edge-strong bg-surface p-0.5">
              {(
                [
                  ["unified", "Birleşik"],
                  ["split", "Yan yana"],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  className={`rounded-md px-[9px] py-[3px] text-[11.5px] ${
                    mode === m ? "bg-brand-tint font-semibold text-brand-ink" : "font-medium text-ink-muted hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </span>
            <button
              type="button"
              onClick={() => onSeen(active.path, !seenSet.has(active.path))}
              aria-pressed={seenSet.has(active.path)}
              className={`shrink-0 rounded-lg border px-2.5 py-1 text-[12px] font-semibold ${
                seenSet.has(active.path)
                  ? "border-brand-edge bg-brand-tint text-brand-ink"
                  : "border-edge-control bg-surface text-ink-body hover:bg-raised"
              }`}
            >
              {seenSet.has(active.path) ? "✓ Görüldü" : "Görüldü olarak işaretle"}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-[1.7]">
            {mode === "unified"
              ? active.lines.map((l, i) =>
                  l.kind === "hunk" ? (
                    <div key={i} className="bg-accent-tint px-4.5 py-1 text-[11.5px] text-accent-ink">
                      {l.text}
                    </div>
                  ) : (
                    <Fragment key={i}>
                      <div className={`grid grid-cols-[44px_44px_18px_minmax(0,1fr)] text-ink ${UNIFIED[l.kind].bg}`}>
                        <span className={`select-none pr-2 text-right text-line-no ${UNIFIED[l.kind].gut}`}>{l.old ?? ""}</span>
                        {newNo(l.neu, UNIFIED[l.kind].gut)}
                        <span className={`select-none text-center ${UNIFIED[l.kind].ink}`}>{UNIFIED[l.kind].sign}</span>
                        <span className="aht-wrap min-w-0 pr-2.5">{l.text}</span>
                      </div>
                      {threadFor(l.neu, false)}
                    </Fragment>
                  ),
                )
              : splitRows(active.lines).map((r, i) =>
                  r.kind === "hunk" ? (
                    <div key={i} className="bg-accent-tint px-4.5 py-1 text-[11.5px] text-accent-ink">
                      {r.text}
                    </div>
                  ) : (
                    <Fragment key={i}>
                      <div className="grid grid-cols-[40px_16px_minmax(0,1fr)_40px_16px_minmax(0,1fr)] text-ink">
                        <span
                          className={`select-none pr-[7px] text-right text-line-no ${
                            !r.left ? "bg-raised" : r.left.changed ? "bg-diff-del-gutter" : "bg-pane"
                          }`}
                        >
                          {r.left?.no ?? ""}
                        </span>
                        <span className={`select-none text-center text-err-ink ${sideBg(r.left, "del")}`}>
                          {r.left?.changed ? "−" : ""}
                        </span>
                        <span className={`aht-wrap min-w-0 pr-2.5 ${sideBg(r.left, "del")}`}>{r.left?.text ?? ""}</span>
                        {newNo(
                          r.right?.no ?? null,
                          `border-l border-edge ${!r.right ? "bg-raised" : r.right.changed ? "bg-diff-add-gutter" : "bg-pane"}`,
                        )}
                        <span className={`select-none text-center text-brand-ink ${sideBg(r.right, "add")}`}>
                          {r.right?.changed ? "+" : ""}
                        </span>
                        <span className={`aht-wrap min-w-0 pr-2.5 ${sideBg(r.right, "add")}`}>{r.right?.text ?? ""}</span>
                      </div>
                      {threadFor(r.right?.no ?? null, true)}
                    </Fragment>
                  ),
                )}
          </div>
        </div>
      )}
    </div>
  );
}

function sideBg(side: { changed: boolean } | null, kind: "add" | "del"): string {
  if (!side) return "bg-raised";
  if (!side.changed) return "bg-surface";
  return kind === "add" ? "bg-diff-add" : "bg-diff-del";
}

function CommentCard({ comment, onRemove }: { comment: LineComment; onRemove: (() => void) | undefined }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-accent-edge bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold text-ink">sen</span>
        <span className="font-mono text-[10.5px] text-ink-muted">
          {fmtAge(comment.at) === "şimdi" ? "şimdi" : `${fmtAge(comment.at)} önce`} · satır {comment.line}
        </span>
        <span className="flex-1" />
        <span className="rounded bg-accent-tint px-1.5 py-px font-mono text-[10.5px] text-accent-ink">red yorumuna eklenecek</span>
        {onRemove && (
          <button type="button" onClick={onRemove} className="text-[11.5px] text-ink-muted underline hover:text-err-ink">
            sil
          </button>
        )}
      </div>
      <span className="aht-wrap text-[13px] leading-[1.55] text-ink-body">{comment.text}</span>
    </div>
  );
}

function DraftCard({
  line,
  text,
  onText,
  onCancel,
  onSave,
}: {
  line: number;
  text: string;
  onText: (t: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-accent-edge bg-surface px-3 py-2.5">
      <span className="font-mono text-[10.5px] text-ink-muted">satır {line} · reddedersen red gerekçesine eklenir</span>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onSave();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Bu satırda neyi düzeltmeli?"
        className="h-16 w-full rounded-lg border border-edge-control bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
      />
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="text-[12px] text-ink-muted hover:text-ink">
          Vazgeç
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!text.trim()}
          className="h-7 rounded-lg bg-accent px-3 text-[12px] font-semibold text-white disabled:opacity-40"
        >
          Yorumu ekle
        </button>
      </div>
    </div>
  );
}
