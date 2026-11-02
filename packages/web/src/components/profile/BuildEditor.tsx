import { useRef, useState, type ReactNode } from "react";

import type { BuildStep, Command, ProjectProfile } from "@ahtapot/shared";

import type { ValidationCheck } from "../../api";
import { EnvTable } from "./EnvTable";

type Build = ProjectProfile["build"];

/**
 * Komut yasak bayrak taşıyor mu? `server/src/build/gate.ts#containsFlag`in
 * aynısı — sözcük sınırıyla, "-c Release" ≠ "-c ReleaseNotes". Ekran kaydı
 * sunucudan ÖNCE engellediği için iki taraf aynı kuralı uygulamalı; ayrışırsa
 * ekran temiz der, kapı reddeder.
 */
export function containsFlag(command: string, flag: string): boolean {
  // Ham JSON düzenlemesinde `run` eksik bir adım forma gelebilir; tip bunu bilmez.
  if (typeof command !== "string" || typeof flag !== "string") return false;
  const norm = command.replace(/\s+/g, " ");
  const f = flag.trim().replace(/\s+/g, " ");
  if (!f) return false;
  const esc = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${esc}(?=\\s|$)`, "i").test(norm);
}

/** Komuttan bayrağı söker; kalan boşlukları tekler. */
function stripFlag(command: string, flag: string): string {
  const parts = flag.trim().split(/\s+/).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (parts.length === 0) return command;
  return command
    .replace(new RegExp(`(^|\\s)${parts.join("\\s+")}(?=\\s|$)`, "gi"), "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Ön adımlar + adımlar içinde yasak bayrak geçen her (adım, bayrak) çifti. */
export function forbiddenHits(build: Build): { step: string; flag: string }[] {
  const out: { step: string; flag: string }[] = [];
  for (const s of [...build.preSteps, ...build.steps]) {
    for (const flag of build.forbiddenFlags) if (containsFlag(s.run, flag)) out.push({ step: s.name, flag });
  }
  return out;
}

const NEW_COMMAND: Command = { name: "", run: "", cwd: ".", timeoutMinutes: 20, optional: false, env: {} };
const NEW_STEP: BuildStep = { ...NEW_COMMAND, whenChanged: [], exceptPaths: [] };

const eyebrow = "font-mono text-[10.5px] uppercase tracking-[.06em] text-ink-muted";
const control = "rounded-lg border border-edge-control bg-surface px-[9px] py-1.5 text-ink focus:border-brand focus:outline-none";

/**
 * Derleme bölümü — tasarımdaki (Workspace Profil · Profil düzenle) kart düzeni.
 *
 * Genel şema formu bu bölüm için yetersizdi: adımların SIRASI bağlayıcı ama
 * dizi editörü sıralamayı göstermiyordu, yasak bayrak ancak sunucu
 * doğrulamasında görünüyordu. Burada sıra sürüklenerek değişir ve bayrak
 * yazıldığı anda adımın üstünde kırmızı yanar.
 */
export function BuildEditor({
  build,
  onChange,
  checks,
}: {
  build: Build;
  onChange: (next: Build) => void;
  /** Sunucu doğrulamasının bu bölüme düşen satırları (`build.<adım>.cwd` gibi). */
  checks: ValidationCheck[];
}) {
  const set = <K extends keyof Build>(k: K, v: Build[K]) => onChange({ ...build, [k]: v });
  const steps = useStableKeys(build.steps.length);
  const pre = useStableKeys(build.preSteps.length);
  // Açık kartlar anahtarla tutulur, indeksle değil: sürükleyince indeks
  // değişir, açık olan kart başka bir adıma atlardı.
  const [open, setOpen] = useState<Set<number>>(() => new Set(steps.keys.slice(0, 2)));
  const [preOpen, setPreOpen] = useState<Set<number>>(new Set());

  const stepChecks = (name: string) => checks.filter((c) => c.level === "error" && c.id.startsWith(`build.${name}.`));

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex flex-col gap-[7px]">
        <div className="flex items-baseline gap-2">
          <span className={eyebrow}>Ön adımlar</span>
          <span className="text-[11.5px] text-ink-dim">her build'de koşar</span>
        </div>
        <div className="overflow-hidden rounded-xl border border-edge bg-surface">
          {build.preSteps.length === 0 && <div className="px-3 py-2.5 text-[12px] text-ink-dim">ön adım yok</div>}
          <Sortable
            items={build.preSteps}
            keys={pre.keys}
            onMove={(from, to) => {
              pre.move(from, to);
              set("preSteps", move(build.preSteps, from, to));
            }}
            render={(s, i, key, handle) => {
              const hits = build.forbiddenFlags.filter((f) => containsFlag(s.run, f));
              // Ön adımın hatası da kartında: yoksa bölüm listesi onu atlıyor
              // ve metin hiçbir yerde görünmüyordu.
              const errs = stepChecks(s.name);
              const put = (next: Command) => set("preSteps", build.preSteps.map((x, j) => (j === i ? next : x)));
              return (
                <div className="border-b border-edge last:border-b-0">
                  <div className="grid grid-cols-[22px_minmax(0,1fr)_24px] items-center gap-2.5 px-3 py-[9px] md:grid-cols-[22px_180px_minmax(0,1fr)_70px_24px_24px]">
                    {handle}
                    <input
                      value={s.name}
                      placeholder="ad"
                      onChange={(e) => put({ ...s, name: e.target.value })}
                      className={`${control} text-[12.5px]`}
                    />
                    <input
                      value={s.run}
                      placeholder="komut"
                      onChange={(e) => put({ ...s, run: e.target.value })}
                      className={`${control} col-span-3 font-mono text-[11.5px] max-md:order-last md:col-span-1 ${hits.length > 0 ? "border-err" : ""}`}
                    />
                    <label className={`${control} hidden items-center gap-1 font-mono text-[11.5px] text-ink-body md:flex`}>
                      <input
                        type="number"
                        min={1}
                        value={s.timeoutMinutes}
                        onChange={(e) => put({ ...s, timeoutMinutes: Math.max(1, Number(e.target.value) || 1) })}
                        className="w-full min-w-0 bg-transparent text-center focus:outline-none"
                        aria-label="zaman aşımı (dakika)"
                      />
                      <span className="text-ink-muted">dk</span>
                    </label>
                    <IconButton
                      label={preOpen.has(key) ? "ayrıntıları kapat" : "ayrıntılar: dizin, ortam, isteğe bağlı"}
                      onClick={() => setPreOpen(toggle(preOpen, key))}
                      className="hidden md:block"
                    >
                      {preOpen.has(key) ? "▾" : "⋯"}
                    </IconButton>
                    <IconButton
                      label={`${s.name || "adımı"} sil`}
                      onClick={() => {
                        pre.remove(i);
                        set("preSteps", build.preSteps.filter((_, j) => j !== i));
                      }}
                    >
                      ×
                    </IconButton>
                  </div>
                  {hits.length > 0 && (
                    <FlagWarning flags={hits} onStrip={() => put({ ...s, run: hits.reduce(stripFlag, s.run) })} />
                  )}
                  {errs.map((c) => (
                    <div key={c.id} className="flex items-start gap-[9px] px-3 pb-2.5 text-[12.5px] leading-[1.55] text-err-body md:pl-[44px]">
                      <span className="mt-0.5 shrink-0 font-mono text-[11px]">!</span>
                      <span>{c.message}</span>
                    </div>
                  ))}
                  {preOpen.has(key) && (
                    <div className="px-3 pb-3 md:pl-[44px]">
                      <CommandDetails cmd={s} onChange={put} />
                    </div>
                  )}
                </div>
              );
            }}
          />
        </div>
        <AddButton
          onClick={() => {
            pre.add();
            set("preSteps", [...build.preSteps, { ...NEW_COMMAND }]);
          }}
        >
          + Ön adım ekle
        </AddButton>
      </div>

      <div className="flex flex-col gap-[7px]">
        <div className="flex items-baseline gap-2">
          <span className={eyebrow}>Adımlar</span>
          <span className="text-[11.5px] text-ink-dim">{build.steps.length} adım · sürükleyerek sırala</span>
        </div>

        <Sortable
          items={build.steps}
          keys={steps.keys}
          gap
          onMove={(from, to) => {
            steps.move(from, to);
            set("steps", move(build.steps, from, to));
          }}
          render={(s, i, key, handle) => {
            const hits = build.forbiddenFlags.filter((f) => containsFlag(s.run, f));
            const errs = stepChecks(s.name);
            const bad = hits.length > 0 || errs.length > 0;
            const put = (next: BuildStep) => set("steps", build.steps.map((x, j) => (j === i ? next : x)));
            const remove = () => {
              steps.remove(i);
              set("steps", build.steps.filter((_, j) => j !== i));
            };

            // Sorunlu kart kapatılamaz: kırmızısı kapalı satırın içinde
            // kaybolur ve "neden kaydetmiyor" sorusu cevapsız kalır.
            if (!open.has(key) && !bad) {
              return (
                <div className="flex items-center gap-2.5 rounded-xl border border-edge bg-surface px-3.5 py-[11px]">
                  {handle}
                  <span className="font-mono text-[11px] text-ink-muted">{i + 1}.</span>
                  <span className="w-[200px] shrink-0 truncate text-[12.5px] text-ink">{s.name || "adsız adım"}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-muted">
                    {s.run}
                    {s.cwd !== "." ? ` · ${s.cwd}` : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => setOpen(toggle(open, key))}
                    className="shrink-0 text-[11.5px] font-semibold text-brand-ink hover:underline"
                  >
                    Aç
                  </button>
                </div>
              );
            }

            return (
              <div
                className={`flex flex-col gap-[9px] rounded-xl border bg-surface px-3.5 py-3 ${
                  bad ? "border-err-edge shadow-[0_0_0_3px_rgba(217,58,46,.08)]" : "border-edge"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  {handle}
                  <span className="font-mono text-[11px] text-ink-muted">{i + 1}.</span>
                  <input
                    value={s.name}
                    placeholder="adım adı"
                    onChange={(e) => put({ ...s, name: e.target.value })}
                    className={`${control} w-[200px] min-w-0 text-[12.5px]`}
                  />
                  <span className="flex-1" />
                  {s.optional && (
                    <span className="rounded-[5px] border border-edge bg-chip px-[7px] py-0.5 font-mono text-[10.5px] text-ink-body">
                      isteğe bağlı
                    </span>
                  )}
                  {errs.map((c) => (
                    <span
                      key={c.id}
                      title={c.message}
                      className="rounded-[5px] bg-err/12 px-[7px] py-0.5 font-mono text-[10.5px] font-semibold text-err-ink"
                    >
                      {c.id.slice(`build.${s.name}.`.length) || "hata"}
                    </span>
                  ))}
                  {!bad && (
                    <IconButton label="kartı kapat" onClick={() => setOpen(toggle(open, key))}>
                      ▴
                    </IconButton>
                  )}
                  <IconButton label={`${s.name || "adımı"} sil`} onClick={remove}>
                    ×
                  </IconButton>
                </div>

                <AutoTextarea
                  value={s.run}
                  placeholder="kabuk komutu"
                  onChange={(v) => put({ ...s, run: v })}
                  className={`block w-full resize-none rounded-lg border px-2.5 py-2 font-mono text-[11.5px] leading-[1.6] text-ink focus:outline-none ${
                    hits.length > 0
                      ? "border-err bg-surface shadow-[0_0_0_3px_rgba(217,58,46,.10)]"
                      : "border-edge-control bg-log focus:border-brand"
                  }`}
                />
                {hits.length > 0 && (
                  <FlagWarning flags={hits} onStrip={() => put({ ...s, run: hits.reduce(stripFlag, s.run) })} />
                )}
                {errs.map((c) => (
                  <div key={c.id} className="flex items-start gap-[9px] text-[12.5px] leading-[1.55] text-err-body">
                    <span className="mt-0.5 shrink-0 font-mono text-[11px]">!</span>
                    <span>{c.message}</span>
                  </div>
                ))}

                <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                  <ChipField
                    label="koşar (whenChanged)"
                    values={s.whenChanged}
                    onChange={(v) => put({ ...s, whenChanged: v })}
                    add="+ glob"
                    empty="boş — her build'de koşar"
                  />
                  <ChipField
                    label="istisna (exceptPaths)"
                    values={s.exceptPaths}
                    onChange={(v) => put({ ...s, exceptPaths: v })}
                    add="+ glob"
                    empty="yok"
                  />
                </div>
                <CommandDetails cmd={s} onChange={(c) => put({ ...s, ...c })} withTimeout />
              </div>
            );
          }}
        />

        <AddButton
          onClick={() => {
            const k = steps.add();
            setOpen(new Set([...open, k]));
            set("steps", [...build.steps, { ...NEW_STEP }]);
          }}
        >
          + Adım ekle
        </AddButton>
      </div>

      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-[minmax(0,1fr)_260px]">
        <ChipField
          label="Yasak bayraklar · komutta geçerse iş reddedilir"
          values={build.forbiddenFlags}
          onChange={(v) => set("forbiddenFlags", v)}
          add="+ bayrak"
          empty=""
          tone="err"
        />
        <div className="flex flex-col gap-[5px]">
          <span className={eyebrow}>Build ne zaman koşar</span>
          <div className="flex rounded-[10px] border border-edge-control bg-surface p-[3px]">
            {(
              [
                ["each-phase", "her safha"],
                ["final-phase", "son safha"],
              ] as const
            ).map(([v, l]) => (
              <button
                key={v}
                type="button"
                onClick={() => set("when", v)}
                className={`flex-1 rounded-[7px] px-2 py-1.5 text-center text-[12px] ${
                  build.when === v ? "bg-brand-tint font-semibold text-brand-ink" : "text-ink-soft hover:text-ink"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          <span className={`text-[11.5px] leading-normal ${build.when === "final-phase" ? "text-wait-ink" : "text-ink-dim"}`}>
            {build.when === "final-phase"
              ? "Hata en sonda çıkar — uzun build için bilinçli takas."
              : "Kırmızı build doğduğu safhanın Developer'ına döner."}
          </span>
          <label className="mt-1 flex items-center gap-2 text-[12px] text-ink-body">
            <input
              type="checkbox"
              checked={build.failureIsBlocking}
              onChange={(e) => set("failureIsBlocking", e.target.checked)}
              className="h-[15px] w-[15px] accent-[var(--color-brand)]"
            />
            Kırmızı build işi durdurur
          </label>
        </div>
      </div>
    </div>
  );
}

/** Adımın ikincil alanları: dizin, zaman aşımı, isteğe bağlılık, ortam değişkenleri. */
function CommandDetails({
  cmd,
  onChange,
  withTimeout = false,
}: {
  cmd: Command;
  onChange: (next: Command) => void;
  withTimeout?: boolean;
}) {
  const envCount = Object.keys(cmd.env).length;
  const [envOpen, setEnvOpen] = useState(envCount > 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2.5">
        <label className="flex min-w-[160px] flex-1 flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[.06em] text-ink-muted">dizin (cwd)</span>
          <input
            value={cmd.cwd}
            onChange={(e) => onChange({ ...cmd, cwd: e.target.value })}
            className={`${control} font-mono text-[11.5px]`}
          />
        </label>
        {withTimeout && (
          <label className="flex w-[110px] flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[.06em] text-ink-muted">zaman aşımı</span>
            <span className={`${control} flex items-center gap-1 font-mono text-[11.5px]`}>
              <input
                type="number"
                min={1}
                value={cmd.timeoutMinutes}
                onChange={(e) => onChange({ ...cmd, timeoutMinutes: Math.max(1, Number(e.target.value) || 1) })}
                className="w-full min-w-0 bg-transparent focus:outline-none"
              />
              <span className="text-ink-muted">dk</span>
            </span>
          </label>
        )}
        <label className="flex h-[31px] items-center gap-2 text-[12px] text-ink-body">
          <input
            type="checkbox"
            checked={cmd.optional}
            onChange={(e) => onChange({ ...cmd, optional: e.target.checked })}
            className="h-[15px] w-[15px] accent-[var(--color-brand)]"
          />
          isteğe bağlı (kırmızısı uyarı düşer)
        </label>
        <button
          type="button"
          onClick={() => setEnvOpen(!envOpen)}
          className="h-[31px] text-[11.5px] text-ink-muted hover:text-ink"
        >
          ortam değişkenleri · {envCount} {envOpen ? "▾" : "▸"}
        </button>
      </div>
      {envOpen && <EnvTable value={cmd.env} onChange={(env) => onChange({ ...cmd, env })} />}
    </div>
  );
}

function FlagWarning({ flags, onStrip }: { flags: string[]; onStrip: () => void }) {
  return (
    <div className="flex items-start gap-[9px] px-0.5 text-[12.5px] leading-[1.55] text-err-body">
      <span className="mt-0.5 shrink-0 font-mono text-[11px]">!</span>
      <span className="min-w-0 flex-1">
        <strong className="font-semibold text-err-ink">Yasak bayrak komutta geçiyor.</strong>{" "}
        <span className="font-mono text-[11px]">{flags.join(", ")}</span> yasak bayraklar listesinde — iş bu komutla
        reddedilir. Bayrağı sil ya da listeden çıkar.
      </span>
      <button
        type="button"
        onClick={onStrip}
        className="shrink-0 whitespace-nowrap text-[11.5px] font-semibold text-err-ink hover:underline"
      >
        Bayrağı sil
      </button>
    </div>
  );
}

/**
 * Glob/bayrak listesi: çip + satır içi giriş. Enter ya da odak kaybı ekler,
 * Backspace boş girişte son çipi siler.
 */
function ChipField({
  label,
  values,
  onChange,
  add,
  empty,
  tone = "neutral",
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  add: string;
  empty: string;
  tone?: "neutral" | "err";
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  };
  const chip =
    tone === "err"
      ? "border-err-edge bg-err-tint text-err-ink text-[11px]"
      : "border-[#e0e6e3] bg-chip text-ink-body text-[10.5px]";
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[.06em] text-ink-muted">{label}</span>
      <span className="flex min-h-[30px] flex-wrap items-center gap-[5px] rounded-lg border border-edge-control bg-surface px-2 py-1.5 focus-within:border-brand">
        {values.map((v) => (
          <span key={v} className={`inline-flex items-center gap-1 rounded-[5px] border px-[7px] py-0.5 font-mono ${chip}`}>
            {v}
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                onChange(values.filter((x) => x !== v));
              }}
              className="opacity-70 hover:opacity-100"
              aria-label={`${v} çıkar`}
            >
              ×
            </button>
          </span>
        ))}
        {values.length === 0 && empty && !draft && <span className="text-[11px] text-ink-dim">{empty}</span>}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && !draft && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={commit}
          placeholder={add}
          className="min-w-[70px] flex-1 bg-transparent font-mono text-[11px] text-ink placeholder:font-sans placeholder:text-ink-dim focus:outline-none"
        />
      </span>
    </label>
  );
}

/**
 * Sürüklenerek sıralanan liste. Tutamak (⋮⋮) yalnız sürüklemeyi başlatır;
 * kartın geri kalanı girişlerle dolu, tümü sürüklenebilir olsaydı metin seçmek
 * kartı sürüklerdi.
 */
function Sortable<T>({
  items,
  keys,
  onMove,
  render,
  gap = false,
}: {
  items: T[];
  keys: number[];
  onMove: (from: number, to: number) => void;
  render: (item: T, index: number, key: number, handle: ReactNode) => ReactNode;
  gap?: boolean;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const body = items.map((item, i) => {
    const key = keys[i] ?? -i - 1;
    const handle = (
      <span
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          setDrag(i);
        }}
        onDragEnd={() => {
          setDrag(null);
          setOver(null);
        }}
        className="shrink-0 cursor-grab select-none font-mono text-[12px] text-[#8b9c95] active:cursor-grabbing"
        title="sürükleyerek sırala"
      >
        ⋮⋮
      </span>
    );
    return (
      <div
        key={key}
        onDragOver={(e) => {
          if (drag === null) return;
          e.preventDefault();
          setOver(i);
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (drag !== null && drag !== i) onMove(drag, i);
          setDrag(null);
          setOver(null);
        }}
        className={`${drag === i ? "opacity-50" : ""} ${over === i && drag !== i ? "rounded-xl outline-2 outline-brand-edge" : ""}`}
      >
        {render(item, i, key, handle)}
      </div>
    );
  });
  return gap ? <div className="flex flex-col gap-[7px]">{body}</div> : <>{body}</>;
}

/**
 * Dizi elemanlarına kalıcı anahtar. İndeks anahtar olsaydı sürüklenen kartın
 * girişi (odak, açık/kapalı) yerinde kalıp başka adıma geçerdi. Uzunluk
 * dışarıdan değişirse (ham JSON düzenlemesi) anahtarlar baştan kurulur.
 */
function useStableKeys(length: number) {
  const next = useRef(0);
  const [keys, setKeys] = useState<number[]>(() => Array.from({ length }, () => next.current++));
  let current = keys;
  if (keys.length !== length) {
    current = Array.from({ length }, () => next.current++);
    setKeys(current);
  }
  return {
    keys: current,
    move: (from: number, to: number) => setKeys(move(current, from, to)),
    remove: (i: number) => setKeys(current.filter((_, j) => j !== i)),
    add: () => {
      const k = next.current++;
      setKeys([...current, k]);
      return k;
    },
  };
}

function move<T>(arr: T[], from: number, to: number): T[] {
  const out = [...arr];
  const [item] = out.splice(from, 1);
  if (item === undefined) return arr;
  out.splice(to, 0, item);
  return out;
}

function toggle(set: Set<number>, k: number): Set<number> {
  const next = new Set(set);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  return next;
}

function AutoTextarea({
  value,
  onChange,
  className,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  className: string;
  placeholder: string;
}) {
  return (
    <textarea
      value={value}
      placeholder={placeholder}
      rows={Math.min(8, Math.max(1, value.split("\n").length, Math.ceil(value.length / 90)))}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      className={className}
    />
  );
}

function IconButton({
  label,
  onClick,
  children,
  className = "",
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`shrink-0 text-center font-mono text-[13px] text-ink-muted hover:text-ink ${className}`}
    >
      {children}
    </button>
  );
}

function AddButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="self-start rounded-[9px] border border-dashed border-brand-edge px-2.5 py-[7px] text-[12px] font-semibold text-brand-ink hover:bg-brand-tint"
    >
      {children}
    </button>
  );
}
