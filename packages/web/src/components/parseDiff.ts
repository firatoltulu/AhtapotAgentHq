/**
 * Unified diff ayrıştırıcısı — React'ten bağımsız, test edilebilir.
 *
 * Sunucu safha kapısı yükünde ham `git diff` metni gönderiyor. Tasarımın dosya
 * listesi ve satır numaralı oluklar için yapı gerekiyor; ham metin blob'u o
 * bilgiyi taşımıyor.
 *
 * Tam bir git-diff çözümleyicisi DEĞİL: başlıktan dosya adını, `@@`den satır
 * numaralarını, `+`/`-` önekinden değişim türünü okur. Binary ve yalnız
 * mod/ad değişimi blokları gövdesiz dosya olarak görünür.
 */

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  old: number | null;
  neu: number | null;
  text: string;
}

export interface DiffFile {
  path: string;
  /** `M` değişti, `+` yeni, `−` silindi. */
  mark: "M" | "+" | "−";
  added: number;
  removed: number;
  lines: DiffLine[];
}

export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  // Hunk İÇİNDE `+++ x` ve `--- x` gerçek ekleme/silmedir; yalnız hunk
  // dışındakiler dosya başlığıdır. Ayrım olmadan kod satırı yutuluyordu.
  let inHunk = false;

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git")) {
      // "diff --git a/x b/y" → b/ tarafı (yeniden adlandırmada hedef ad).
      const m = / b\/(.+)$/.exec(raw);
      cur = { path: m?.[1] ?? raw.slice(11), mark: "M", added: 0, removed: 0, lines: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;

    if (raw.startsWith("new file")) {
      cur.mark = "+";
      continue;
    }
    if (raw.startsWith("deleted file")) {
      cur.mark = "−";
      continue;
    }

    // Başlık gürültüsü gövdeye girmez; girerse `+++`/`---` ekleme/silme sanılır.
    // Ama YALNIZ hunk dışında: gövdedeki "+++ x" eklenen bir kod satırıdır.
    if (
      !inHunk && (
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("similarity") ||
      raw.startsWith("rename ") ||
      raw.startsWith("old mode") ||
      raw.startsWith("new mode") ||
      raw.startsWith("Binary files"))
    ) {
      continue;
    }

    if (raw.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldNo = Number(m?.[1] ?? 0);
      newNo = Number(m?.[2] ?? 0);
      cur.lines.push({ kind: "hunk", old: null, neu: null, text: raw });
      inHunk = true;
      continue;
    }

    if (raw.startsWith("\\")) {
      // "\ No newline at end of file" — bilgi satırı, sayaçlara girmez.
      continue;
    }

    if (raw.startsWith("+")) {
      cur.added++;
      cur.lines.push({ kind: "add", old: null, neu: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      cur.removed++;
      cur.lines.push({ kind: "del", old: oldNo++, neu: null, text: raw.slice(1) });
    } else if (inHunk && raw.startsWith(" ")) {
      // Bağlam satırı YALNIZ " " ile başlar. Patch'in sonundaki boş satır
      // (git çıktısı `\n` ile biter) aksi hâlde sahte bir ctx satırı üretirdi.
      cur.lines.push({ kind: "ctx", old: oldNo++, neu: newNo++, text: raw.slice(1) });
    }
  }

  return files;
}

/** Yan yana görünümün bir tarafı; `changed` false ise bağlam satırıdır. */
export interface SplitSide {
  no: number;
  text: string;
  changed: boolean;
}

export type SplitRow =
  | { kind: "hunk"; text: string }
  | { kind: "row"; left: SplitSide | null; right: SplitSide | null };

/**
 * Birleşik satırları yan yana satırlara dizer.
 *
 * Ardışık silme bloğu ile onu izleyen ekleme bloğu AYNI satırlarda eşlenir:
 * değişen satırın eski ve yeni hâli karşılıklı okunur. Bloklardan biri
 * uzunsa karşı taraf boş kalır. Bağlam satırı iki tarafa da yazılır.
 */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];

  const side = (l: DiffLine | undefined, no: number | null | undefined, changed: boolean): SplitSide | null =>
    l && no != null ? { no, text: l.text, changed } : null;

  const flush = (): void => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const d = dels[i];
      const a = adds[i];
      out.push({ kind: "row", left: side(d, d?.old, true), right: side(a, a?.neu, true) });
    }
    dels = [];
    adds = [];
  };

  for (const l of lines) {
    if (l.kind === "del") {
      // Ekleme bloğundan SONRA gelen silme yeni bir değişim grubudur; önceki
      // grup kapanmazsa sonraki satırlar yanlış karşılıklarla eşlenirdi.
      if (adds.length > 0) flush();
      dels.push(l);
      continue;
    }
    if (l.kind === "add") {
      adds.push(l);
      continue;
    }
    flush();
    if (l.kind === "hunk") out.push({ kind: "hunk", text: l.text });
    else out.push({ kind: "row", left: side(l, l.old, false), right: side(l, l.neu, false) });
  }
  flush();
  return out;
}
