/**
 * Mentor önerisinin koşan oturuma teslim kapısı.
 *
 * Motor döngü sinyali yakalayınca `hold` der; agent'ın SIRADAKİ araç çağrısı
 * (`PreToolUse` kancası `take`i bekler) mentor cevabı gelene kadar durur.
 * Cevap `release` ile gelir ve o çağrıya ek bağlam olarak düşer. Tur
 * kesilmez, oturum ve bağlam korunur; canlı kanalı olmayan tek atışlık
 * roller de (QA, DevOps) cevabı böyle alır.
 *
 * Hem köprü (konteyner) hem `LocalTransport` (host) aynı sınıfı kullanır;
 * SDK'yı bilmez, yalnız bekletir ve metni bir kez verir.
 */
export class GuideGate {
  private waiters: (() => void)[] = [];
  private held = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: string | null = null;

  /**
   * Sıradaki araç çağrısını beklet. Süre dolarsa kapı kendiliğinden açılır:
   * mentor düşse ya da asılsa bile agent sonsuza beklememeli.
   */
  hold(timeoutMs: number): void {
    if (this.held) return;
    this.held = true;
    this.timer = setTimeout(() => this.release(null), timeoutMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Cevabı bırak (ya da `null`: danışma atlandı) ve bekleyenleri sal.
   *
   * Kapı tutulmuyorsa YOK SAYILIR: süre dolup kapı açıldıktan sonra gelen
   * cevap `pending`e düşerse sonraki, alakasız bir araç çağrısına yapışırdı.
   */
  release(text: string | null): void {
    if (!this.held) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (text) this.pending = text;
    this.held = false;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  /**
   * Kanca burada bekler. Metin YALNIZ BİR çağrıya verilir: paralel araç
   * çağrılarında öneri her birine ayrı ayrı yapıştırılmamalı.
   */
  async take(): Promise<string | null> {
    if (this.held) await new Promise<void>((r) => this.waiters.push(r));
    const t = this.pending;
    this.pending = null;
    return t;
  }

  get isHeld(): boolean {
    return this.held;
  }
}
