/**
 * Döngü tespiti — agent takıldı mı?
 *
 * Agent'ın METNİNE bakılmaz, yalnız araç davranışına: LLM döngüde olduğunu
 * kabul etmiyor, "takılırsan sor" talimatı da bu yüzden işe yaramıyor.
 * Gözlenen (2026-10-09): canlı test ve CI oturumlarında aynı dosya arada hiç
 * yazılmadan defalarca okunuyor; tur ve bütçe ilerleme olmadan yanıyor.
 *
 * Saf durum makinesi: runner olayları besler, sinyal döner. G/Ç yok.
 *
 * Yanlış pozitif yönünde temkinli: emin olunamayan her durumda sayaç
 * SIFIRLANIR (yolu geçen bir kabuk komutu, herhangi bir yazma). Kaçırılan
 * döngü bir sonraki eşikte yakalanır; yanlış alarm ise insanın sinyale
 * güvenini bitirir.
 */

export type StuckSignalKind = "repeat_read" | "repeat_failure" | "no_progress";

export interface StuckSignal {
  signal: StuckSignalKind;
  target: string;
  count: number;
  detail: string;
}

export interface StuckThresholds {
  repeatRead: number;
  repeatFailure: number;
  noProgressTools: number;
}

/** Dosya yazan araçlar — okuma sayaçlarını ve ilerlemesizliği sıfırlar. */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export class StuckDetector {
  /** okuma anahtarı → arada yazma olmadan kaç kez. */
  private readonly reads = new Map<string, number>();
  /** okuma anahtarı → yolu (yazmada hangi anahtarların düşeceği için). */
  private readonly readPaths = new Map<string, string>();
  /** hata anahtarı (araç+hedef+imza) → kaç kez. */
  private readonly failures = new Map<string, number>();
  /** toolId → araç adı + hedef; sonuç gelince hata anahtarı buradan kurulur. */
  private readonly pending = new Map<string, { name: string; target: string }>();
  private sinceWrite = 0;

  constructor(
    private readonly t: StuckThresholds,
    /** Yazma beklenmeyen rolde (Planner, triage, tester) `no_progress` anlamsız. */
    private readonly expectWrites: boolean,
  ) {}

  onToolUse(toolId: string, name: string, input: unknown): StuckSignal | null {
    const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const target = targetOf(name, inp);
    this.pending.set(toolId, { name, target });

    if (WRITE_TOOLS.has(name)) {
      this.sinceWrite = 0;
      this.forgetPath(target);
      // Yazma arama sonuçlarını değiştirebilir; desen sayaçları baştan.
      for (const k of [...this.reads.keys()]) if (!this.readPaths.has(k)) this.reads.delete(k);
      return null;
    }

    if (name === "Bash") {
      // Komut bir dosyayı değiştirmiş olabilir (sed -i, git checkout, build
      // çıktısı). Ayırt etmek kırılgan; yolu geçiyorsa o okuma meşrulaşır.
      for (const [k, path] of this.readPaths) {
        if (mentions(target, path)) {
          this.reads.delete(k);
          this.readPaths.delete(k);
        }
      }
    }

    const signal = this.countRead(name, inp, target);
    if (signal) return signal;

    if (!this.expectWrites) return null;
    this.sinceWrite++;
    if (this.sinceWrite % this.t.noProgressTools === 0) {
      return {
        signal: "no_progress",
        target: "",
        count: this.sinceWrite,
        detail: `${this.sinceWrite} araç çağrısıdır worktree'ye hiçbir şey yazılmadı`,
      };
    }
    return null;
  }

  onToolResult(toolId: string, ok: boolean, text: string, exitCode?: number): StuckSignal | null {
    const call = this.pending.get(toolId);
    this.pending.delete(toolId);
    if (!call) return null;

    const failed = !ok || (exitCode !== undefined && exitCode !== 0);
    const prefix = `${call.name}\u0000${call.target}\u0000`;
    if (!failed) {
      // Aynı hedef başarılı oldu: o hedefin hata geçmişi kapandı.
      for (const k of [...this.failures.keys()]) if (k.startsWith(prefix)) this.failures.delete(k);
      return null;
    }

    // Hata DEĞİŞİYORSA ilerleme vardır (dotnet build'de bir hatayı çözüp
    // sıradakine geçmek) — anahtar imzayı da taşır, farklı hata yeni sayaçtır.
    const key = prefix + errorSignature(text);
    const n = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, n);
    if (n % this.t.repeatFailure !== 0) return null;
    return {
      signal: "repeat_failure",
      target: call.target,
      count: n,
      detail: `${call.name} aynı hatayla ${n} kez kırıldı: ${call.target}`,
    };
  }

  private countRead(name: string, inp: Record<string, unknown>, target: string): StuckSignal | null {
    let key: string;
    if (name === "Read") {
      // Farklı aralıkla sayfalama döngü değildir; aralık anahtara girer.
      key = `Read\u0000${target}\u0000${str(inp["offset"])}\u0000${str(inp["limit"])}`;
      this.readPaths.set(key, target);
    } else if (name === "Grep" || name === "Glob") {
      // Salt okunur Planner'ın döngüsü böyle görünür: aynı desen, aynı yer.
      key = `${name}\u0000${target}\u0000${str(inp["path"])}\u0000${str(inp["glob"])}\u0000${str(inp["type"])}`;
    } else {
      return null;
    }
    const n = (this.reads.get(key) ?? 0) + 1;
    this.reads.set(key, n);
    if (n % this.t.repeatRead !== 0) return null;
    const where = name === "Read" ? target : `${name} "${target}"`;
    return {
      signal: "repeat_read",
      target,
      count: n,
      detail: `${where} arada yazma olmadan ${n} kez okundu`,
    };
  }

  private forgetPath(path: string): void {
    for (const [k, p] of this.readPaths) {
      if (p === path) {
        this.reads.delete(k);
        this.readPaths.delete(k);
      }
    }
  }
}

/** Aracın hedefi: dosya yolu, arama deseni ya da normalize komut. */
export function targetOf(name: string, inp: Record<string, unknown>): string {
  if (name === "Bash") return str(inp["command"]).replace(/\s+/g, " ").trim();
  if (name === "Grep" || name === "Glob") return str(inp["pattern"]);
  const path = inp["file_path"] ?? inp["notebook_path"];
  if (typeof path === "string") return path;
  const json = JSON.stringify(inp);
  return json.length > 200 ? json.slice(0, 200) : json;
}

/** Komut yolu ya da (yeterince ayırt ediciyse) dosya adını geçiyor mu? */
function mentions(command: string, path: string): boolean {
  if (command.includes(path)) return true;
  const base = path.split(/[\\/]/).pop() ?? "";
  return base.length >= 4 && command.includes(base);
}

/**
 * Hatanın kimliği: sondaki satırlar, değişken parçalar atılmış.
 *
 * Hata çoğu zaman sonda olur. Sayılar (satır no, süre, PID) ve yollar her
 * denemede oynar; atılmazsa aynı hata her seferinde "yeni" görünür ve
 * döngü hiç yakalanmaz.
 */
export function errorSignature(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-5)
    .join(" ")
    .replace(/(?:[A-Za-z]:)?[\\/][^\s:'"()]+/g, "<yol>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 400);
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}
