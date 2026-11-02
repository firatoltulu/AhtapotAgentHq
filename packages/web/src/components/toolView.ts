import type { ServerEvent } from "@ahtapot/shared";

/**
 * BAĞIMSIZ modül: göreli import YOK.
 *
 * Vite uzantısız göreli yolu çözer ama `node --experimental-strip-types` ile
 * koşan test çözemez; `.ts` yazınca da `tsc` reddeder
 * (`allowImportingTsExtensions`). İkisini birden memnun etmenin yolu, araç adı
 * sınıflandırmasını burada tutmak — zaten araç çizimiyle aynı karar.
 */

/**
 * Olayı zaman çizgisinde çizilecek hâle getirir.
 *
 * Akış kart yığınıydı: her olay aynı görünüyor, `Edit` satırı ham JSON basıyor
 * ve komut kartıyla dosya kartı ayırt edilemiyordu. Operatör "ne oldu"yu
 * okumak için JSON ayrıştırmak zorunda kalıyordu.
 *
 * Burası olayı bir TON'a ve o tona uygun gövdeye indirger. Ham argüman JSON'u
 * hiçbir tonda geçmez — `inputSummary` yalnız tanınmayan araçta ve son çare
 * olarak, tek satıra kırpılmış hâlde görünür.
 *
 * Yapılandırılmış alanlar (`file`, `meta`, `diff`) SUNUCUDAN gelir: `inputSummary`
 * 200 karakterde kesildiği için istemci farkı geri kuramaz. Alan yoksa (bu
 * alanlar eklenmeden yazılmış olaylar replay'de gelir) yol yine de dizeden
 * kurtarılmaya çalışılır — eski işler tamamen okunaksız kalmasın.
 */

export type Tone = "meta" | "think" | "read" | "edit" | "cmd" | "msg" | "gate";

/** Tonun etiketi — araç adı yoksa bu basılır. */
const TONE_LABELS: Record<Tone, string> = {
  meta: "durum",
  think: "düşünce",
  read: "okudu",
  edit: "düzenledi",
  cmd: "komut",
  msg: "mesaj",
  gate: "onay kapısı",
};

/** Kabuk komutu çalıştıran araçlar. */
const SHELL_TOOLS = new Set(["bash", "bashoutput", "powershell"]);
/** Dosya okuyan/yazan araçlar — tonu ada göre ayırmak için. */
const READ_TOOLS = new Set(["read", "notebookread", "glob", "grep"]);
const EDIT_TOOLS = new Set(["edit", "write", "notebookedit", "multiedit"]);

export interface ToolView {
  tone: Tone;
  /** Başlıktaki etiket: araç adı ya da tonun karşılığı. */
  label: string;
  /** Olayı kim üretti — "developer · sonnet-4-6", "orchestrator". */
  actor: string;

  // read / edit
  /** Yolun dizin kısmı, sonda ayraçla. */
  dir: string;
  /** Yolun dosya adı kısmı. */
  file: string;
  meta: string[];
  diff: [("-" | "+"), string][];

  // cmd
  command: string;
  cwd: string;

  /** Anlatı gövdesi — msg/think/meta/gate tonlarında tek içerik. */
  text: string;
}

/** Yolu dizin + dosya adı olarak ayırır; ayraç dizinde kalır. */
export function splitPath(path: string): { dir: string; file: string } {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (at < 0) return { dir: "", file: path };
  return { dir: path.slice(0, at + 1), file: path.slice(at + 1) };
}

/**
 * Kesilmiş `inputSummary`den dosya yolunu kurtarmayı dener.
 *
 * Yalnız ESKİ olaylar için: `file` alanı eklenmeden yazılmış bir `Edit`
 * replay'de gelirse hiç olmazsa hangi dosya olduğu görünsün. Kesme `file_path`
 * değerinin ortasına düşmüşse bulunamaz ve boş döner — uydurmaz.
 */
export function fileFromSummary(summary: string): string {
  const m = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(summary);
  if (!m?.[1]) return "";
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return "";
  }
}

/** Araç adına göre ton. */
function toolTone(name: string): Tone {
  const n = name.toLowerCase();
  if (SHELL_TOOLS.has(n)) return "cmd";
  if (EDIT_TOOLS.has(n)) return "edit";
  if (READ_TOOLS.has(n)) return "read";
  // Tanınmayan araç (MCP araçları, ask_user…) anlatı sayılır: ham JSON
  // basmaktansa okunur bir satır göstermek daha iyi.
  return "read";
}

function empty(tone: Tone, label: string, text: string, actor = ""): ToolView {
  return { tone, label, actor, dir: "", file: "", meta: [], diff: [], command: "", cwd: "", text };
}

/** `inputSummary` son çare: tek satıra indirgenir, JSON süsü atılır. */
function summaryLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

export function toolView(e: ServerEvent): ToolView {
  switch (e.type) {
    case "agent.tool_use": {
      const tone = toolTone(e.name);
      const path = e.file ?? (tone === "edit" || tone === "read" ? fileFromSummary(e.inputSummary) : "");
      const { dir, file } = splitPath(path);
      return {
        tone,
        label: e.name,
        actor: "",
        dir,
        file,
        meta: e.meta,
        diff: e.diff,
        command: e.command ?? "",
        cwd: e.cwd ?? "",
        // Yol da komut da yoksa özet tek satır olarak son çare gövde olur;
        // aksi hâlde ham JSON hiç basılmaz.
        text: path || e.command ? "" : summaryLine(e.inputSummary),
      };
    }

    case "agent.tool_result": {
      // Çağrısı akışta yoksa (replay penceresi) sonuç tek başına okunabilmeli.
      const head = e.exitCode !== undefined ? `exit ${e.exitCode}` : e.ok ? "ok" : "hata";
      return empty("read", "sonuç", `${head} · ${e.summary}`);
    }

    case "agent.start":
      return empty("meta", TONE_LABELS.meta, `başladı${e.sessionId ? " · oturum devralındı" : ""}`, `${e.role} · ${e.model}`);
    case "agent.thinking":
      return empty("think", TONE_LABELS.think, e.text);
    case "agent.message":
      // Rol görünmezse insanın yazdığı ve sistemin düştüğü notlar agent'ın
      // sözü sanılır — sohbet geçmişi yanlış okunur.
      return empty(
        "msg",
        TONE_LABELS.msg,
        e.content,
        e.role === "assistant" ? "" : e.role === "user" ? "sen" : "sistem",
      );
    case "agent.question":
      return empty("gate", "soru", e.text);
    case "agent.stuck":
      // Gözlem modu: motor döngüden şüpheleniyor, henüz müdahale yok.
      return empty("gate", "döngü şüphesi", e.detail, `${e.role} · ${e.model}`);
    case "agent.mentor":
      // Danışma sonucu: öneri ya da neden atlandığı. Maliyet görünür olmalı —
      // mentor pahalı basamaktır.
      return empty(
        "gate",
        e.outcome === "advised" ? "mentor önerisi" : "mentor atlandı",
        e.outcome === "advised"
          ? `${e.advice}${e.costMicroUsd > 0 ? `\n\n$${(e.costMicroUsd / 1_000_000).toFixed(3)}` : ""}`
          : e.reason,
        e.mentorModel ? `${e.juniorModel} → ${e.mentorModel}` : e.juniorModel,
      );
    case "agent.end":
      return empty("meta", TONE_LABELS.meta, "", "");

    case "approval.required":
      return empty("gate", TONE_LABELS.gate, `${e.kind} kapısı insan onayı bekliyor`, "orchestrator");
    case "job.state":
      return empty("meta", TONE_LABELS.meta, `${e.state} · faz ${e.phase}`, "orchestrator");
    case "job.error":
      return empty("meta", "hata", `${e.code}: ${e.message}`, "orchestrator");
    case "live.ready":
      return empty("meta", "canlı ortam", `${e.url} · port ${e.ports.join(", ")}`, "orchestrator");
    case "cost.update":
      return empty("meta", TONE_LABELS.meta, "", "orchestrator");
    case "build.log":
      return empty("cmd", "build", e.line);

    default:
      return empty("meta", TONE_LABELS.meta, "");
  }
}

/**
 * Komut satırının başlığı — ne yapmaya çalışıyor.
 *
 * Tasarım "Test projesini derle" gibi insan dilinde bir amaç istiyor, ama onu
 * üretmek komutu YORUMLAMAK demek ve yanlış yorum komutun kendisinden kötü.
 * Bunun yerine komutun ilk anlamlı parçası alınır: `npm run build` → "npm run
 * build". Operatör zaten komutun tamamını bir alt satırda görüyor.
 */
export function commandLabel(command: string): string {
  const first = command.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = first.trim();
  return trimmed.length > 72 ? `${trimmed.slice(0, 72)}…` : trimmed;
}

/** Başarısız komutta ne yapılmalı — çıkış koduna göre tek satır. */
export function exitHint(exitCode: number | undefined, ok: boolean): string {
  if (exitCode === 0 || (exitCode === undefined && ok)) return "";
  if (exitCode === 127) return "Komut bulunamadı — konteynerde kurulu mu?";
  if (exitCode === 137) return "Süreç öldürüldü (OOM ya da zaman aşımı).";
  if (exitCode === 130) return "Kesildi (SIGINT).";
  return "Komut kırıldı — çıktının son satırları nedeni söyler.";
}
