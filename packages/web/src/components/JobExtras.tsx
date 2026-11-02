import { useState } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";

import { referencePathProblem } from "@ahtapot/shared";

import { api } from "../api";
import { ErrorText } from "../ui";

export interface UploadedFile {
  id: string;
  fileName: string;
  sizeBytes: number;
}

/** Sunucudaki `MIME_BY_EXT` ile aynı küme; ikisi birlikte değişir. */
const EXTS = ["png", "jpg", "jpeg", "gif", "webp", "html", "htm", "txt", "log", "md", "csv", "json", "xml", "yaml", "yml"];
const extOf = (name: string) => name.toLowerCase().split(".").pop() ?? "";
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];

/**
 * İlgili dosyalar ayrı bir alan değil, açıklamanın SONUNA gömülür (agent
 * açıklamayı okur, ayrı alanı okumaz). İş detayı listeyi geri ayırmak için aynı
 * başlığı arar — ikisi bu tek sabitten beslenir, biri değişip öbürü kopmasın.
 */
const RELATED_FILES_HEADER = "İlgili dosyalar (ilk okunacaklar):";

export function withRelatedFiles(description: string, files: string[]): string {
  if (files.length === 0) return description;
  return `${description}\n\n${RELATED_FILES_HEADER}\n${files.map((f) => `- ${f}`).join("\n")}`;
}

/** `withRelatedFiles`in tersi; başlık yoksa açıklama olduğu gibi döner. */
export function splitRelatedFiles(text: string): { description: string; files: string[] } {
  const at = text.lastIndexOf(`\n${RELATED_FILES_HEADER}\n`);
  const start = at >= 0 ? at : text.startsWith(`${RELATED_FILES_HEADER}\n`) ? 0 : -1;
  if (start < 0) return { description: text, files: [] };
  const tail = text.slice(start).trim().split("\n").slice(1);
  // Başlığın altı yalnız "- yol" satırlarıysa gömülü listedir; değilse
  // kullanıcı metni aynı cümleyi içeriyordur, dokunulmaz.
  if (tail.length === 0 || !tail.every((l) => l.startsWith("- "))) return { description: text, files: [] };
  return { description: text.slice(0, start).trimEnd(), files: tail.map((l) => l.slice(2)) };
}

/**
 * Yeni iş formunun "İlgili dosyalar" + "Ek dosyalar" blokları — issue'dan da
 * issue'suz da aynı: workspace yolları metin listesi (açıklamaya gömülür) ve
 * görsel/HTML/metin yükleme (`/api/uploads`, iş açılınca bağlanır).
 *
 * Görsel üç yoldan gelir: seçici, sürükle-bırak ve pano (⌘V). Ekran görüntüsü
 * çoğunlukla panodadır; dosyaya kaydetmeyi şart koşmak adımı uzatıyordu.
 */
export function ExtrasFields({
  relatedFiles,
  onRelatedFilesChange,
  referencePaths,
  onReferencePathsChange,
  attachments,
  onAttachmentsChange,
}: {
  relatedFiles: string[];
  onRelatedFilesChange: (files: string[]) => void;
  referencePaths: string[];
  onReferencePathsChange: (paths: string[]) => void;
  attachments: UploadedFile[];
  onAttachmentsChange: (files: UploadedFile[]) => void;
}) {
  return (
    <>
      <PathList
        title="İlgili dosyalar"
        paths={relatedFiles}
        onChange={onRelatedFilesChange}
        normalize={githubPath}
        placeholder="workspace'te yol yaz ya da GitHub linki yapıştır…"
      />

      <PathList
        title="Emsal"
        hint="host'taki dizin · agent'a salt okunur bağlanır"
        paths={referencePaths}
        onChange={onReferencePathsChange}
        normalize={(v) => v.replace(/^"(.*)"$/, "$1").replace(/(.)[\\/]+$/, "$1")}
        validate={referencePathProblem}
        suggest={suggestReferenceDirs}
        placeholder="C:\src\northwind\src\Plugins"
      />

      <AttachmentDrop attachments={attachments} onChange={onAttachmentsChange} />
    </>
  );
}

/** Yüklenmiş ama işe bağlanmamış ekleri bırakır — vazgeçilen formun artığı. */
export function discardUploads(files: UploadedFile[]): void {
  for (const f of files) void api.deleteUpload(f.id).catch(() => undefined);
}

/**
 * Yükleme kutusu + yüklenenlerin listesi. Yeni iş formu her türü alır; red
 * ve yeniden açma yorumu (`imagesOnly`) yalnız görsel — motor orada başka
 * türü reddeder, çünkü agent'a "şunu gör" diye gösterilen şey ekran görüntüsü.
 */
export function AttachmentDrop({
  attachments,
  onChange,
  imagesOnly = false,
}: {
  attachments: UploadedFile[];
  onChange: (files: UploadedFile[]) => void;
  imagesOnly?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const exts = imagesOnly ? IMAGE_EXTS : EXTS;
  // Birden çok dosya art arda yüklenir; her biri kendi `onSuccess` kapanışındaki
  // bayat `attachments`ı kullansaydı sonuncusu öncekileri ezerdi — o yüzden
  // birikim tek mutasyonda, sonda tek çağrıyla yazılır.
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const done: UploadedFile[] = [];
      try {
        for (const f of files) done.push(await api.upload(f));
      } finally {
        if (done.length > 0) onChange([...attachments, ...done]);
      }
    },
  });

  const removeAttachment = (id: string) => {
    onChange(attachments.filter((a) => a.id !== id));
    void api.deleteUpload(id).catch(() => undefined);
  };

  const take = (files: Iterable<File>) => {
    const ok = [...files].filter((f) => exts.includes(extOf(f.name)));
    if (ok.length > 0) upload.mutate(ok);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {attachments.map((a) => (
        <div key={a.id} className="flex items-center gap-2.5 rounded-[10px] border border-edge bg-surface px-3 py-2">
          <span className="flex h-7 w-9 shrink-0 items-center justify-center rounded-md border border-edge bg-chip font-mono text-[9px] text-ink-muted">
            {(IMAGE_EXTS.includes(extOf(a.fileName)) ? extOf(a.fileName) : extOf(a.fileName).slice(0, 4)).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-body">
            {a.fileName} <span className="font-mono text-[10.5px] text-ink-muted">· {Math.max(1, Math.round(a.sizeBytes / 1024))} KB</span>
          </span>
          <button
            type="button"
            onClick={() => removeAttachment(a.id)}
            className="shrink-0 font-mono text-[12px] text-ink-muted hover:text-ink"
            aria-label={`${a.fileName} dosyasını çıkar`}
          >
            ×
          </button>
        </div>
      ))}
      <label
        tabIndex={0}
        onPaste={(e) => take(e.clipboardData.files)}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          take(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer items-center gap-2.5 rounded-[10px] border border-dashed px-3 py-2.5 focus:border-brand focus:outline-none ${
          dragging ? "border-brand bg-brand-tint" : "border-edge-control bg-surface hover:bg-raised"
        }`}
      >
        <span className="min-w-0 flex-1 text-[12px] text-ink-body">
          {upload.isPending
            ? "yükleniyor…"
            : imagesOnly
              ? "Görsel ekle · ekran görüntüsü · her biri en çok 5 MB"
              : "Ek dosya · görsel, HTML, metin · her biri en çok 5 MB"}
        </span>
        <span className="shrink-0 text-[11.5px] text-ink-muted">+ dosya bırak / ⌘V</span>
        <input
          type="file"
          accept={exts.map((e) => `.${e}`).join(",")}
          multiple
          className="hidden"
          disabled={upload.isPending}
          onChange={(e) => {
            if (e.target.files) take(e.target.files);
            e.target.value = "";
          }}
        />
      </label>
      <ErrorText error={upload.error} />
    </div>
  );
}

/** Yalnız `AHTAPOT_WORKSPACES_ROOT`un doğrudan alt dizinleri; kök tanımlı değilse öneri yok. */
async function suggestReferenceDirs(q: string): Promise<string[]> {
  return (await api.referenceDirs(q)).dirs;
}

/**
 * Yazılıp Enter'la eklenen yol listesi. `validate` hata metni döndürürse eklenmez.
 * `suggest` verilirse odaktayken öneri listesi açılır; öneri seçmek yolu ekler.
 */
function PathList({
  title,
  hint,
  paths,
  onChange,
  normalize,
  validate,
  suggest,
  placeholder,
}: {
  title: string;
  hint?: string;
  paths: string[];
  onChange: (paths: string[]) => void;
  normalize: (v: string) => string;
  validate?: (v: string) => string | null;
  suggest?: (q: string) => Promise<string[]>;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [hi, setHi] = useState(-1);
  const suggestions = useQuery({
    queryKey: ["path-suggest", title, draft],
    queryFn: () => suggest!(draft),
    enabled: Boolean(suggest) && focused,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const options = focused ? (suggestions.data ?? []).filter((s) => !paths.includes(s)) : [];

  const pick = (s: string) => {
    setHi(-1);
    setError(null);
    setDraft("");
    if (!paths.includes(s)) onChange([...paths, s]);
  };

  const add = () => {
    const v = normalize(draft.trim());
    if (!v) return;
    const problem = validate?.(v) ?? null;
    setError(problem);
    if (problem || paths.includes(v)) return;
    onChange([...paths, v]);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[10.5px] uppercase tracking-[.06em] text-ink-muted">
        {title} · {paths.length} yol
        {hint && <span className="normal-case tracking-normal text-ink-dim"> — {hint}</span>}
      </span>
      <div className="overflow-hidden rounded-[10px] border border-edge bg-surface">
        {paths.map((f) => (
          <div key={f} className="flex items-center gap-2 border-b border-edge px-2.5 py-[7px]">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">{f}</span>
            <button
              type="button"
              onClick={() => onChange(paths.filter((x) => x !== f))}
              className="shrink-0 font-mono text-[12px] text-ink-muted hover:text-ink"
              aria-label={`${f} yolunu çıkar`}
            >
              ×
            </button>
          </div>
        ))}
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
            setHi(-1);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && options.length > 0) {
              e.preventDefault();
              setHi((i) => (i + 1) % options.length);
            } else if (e.key === "ArrowUp" && options.length > 0) {
              e.preventDefault();
              setHi((i) => (i <= 0 ? options.length - 1 : i - 1));
            } else if ((e.key === "Enter" || e.key === "Tab") && hi >= 0 && options[hi]) {
              e.preventDefault();
              pick(options[hi]);
            } else if (e.key === "Enter") {
              e.preventDefault();
              add();
            } else if (e.key === "Escape") {
              setHi(-1);
              setFocused(false);
            }
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setHi(-1);
            add();
          }}
          placeholder={placeholder}
          className="block w-full bg-transparent px-2.5 py-[7px] font-mono text-[11px] text-ink placeholder:text-ink-dim focus:outline-none"
        />
        {options.length > 0 && (
          <div className="max-h-48 overflow-auto border-t border-edge bg-raised">
            {options.map((s, i) => (
              <button
                key={s}
                type="button"
                // Tıklama input'un blur'undan ÖNCE işlensin: yoksa blur yarım
                // taslağı listeye ekler.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                className={`block w-full truncate px-2.5 py-[5px] text-left font-mono text-[11px] ${
                  i === hi ? "bg-brand-tint text-brand-ink" : "text-ink-body hover:bg-sunken"
                }`}
                title={s}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <span className="text-[11.5px] text-err-text">{error}</span>}
    </div>
  );
}

/**
 * GitHub blob linki → repo-göreli yol. `https://github.com/o/r/blob/main/a/b.cs#L12`
 * → `a/b.cs`. Planner linki değil yolu okur; link olduğu gibi kalsaydı
 * worktree'de karşılığı bulunmazdı. Link değilse metin aynen döner.
 */
function githubPath(v: string): string {
  const m = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/(?:blob|tree)\/[^/]+\/([^#?]+)/.exec(v);
  return m?.[1] ? decodeURIComponent(m[1]) : v;
}
