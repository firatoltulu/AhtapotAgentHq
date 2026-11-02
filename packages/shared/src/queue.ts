/**
 * Asenkron kuyruk — üretici `push`, tüketici `for await`.
 *
 * Üç yerde aynı ihtiyaç var: SDK'ya canlı kullanıcı mesajı akıtmak, köprüden
 * gelen SDK olaylarını sunucuda tüketmek, köprü içinde sunucudan gelen mesajı
 * SDK'ya iletmek. Kuyruk boşken bekleyen bir promise tutulur; `push` onu çözer.
 *
 * `fail` tüketiciyi hata ile bitirir: köprü koptuğunda bekleyen `for await`
 * sonsuza dek asılı kalmamalı.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: ((r: IteratorResult<T>) => void) | null = null;
  private failWaiter: ((e: unknown) => void) | null = null;
  private done = false;
  private error: unknown = null;

  get closed(): boolean {
    return this.done;
  }

  push(item: T): void {
    if (this.done) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      this.failWaiter = null;
      w({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  /** Kuyruktakiler tüketildikten sonra akış biter. */
  end(): void {
    if (this.done) return;
    this.done = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      this.failWaiter = null;
      w({ value: undefined as never, done: true });
    }
  }

  /** Akışı hata ile bitirir; kuyruktakiler ATILIR — tüketici hemen hatayı görür. */
  fail(err: unknown): void {
    if (this.done) return;
    this.done = true;
    this.error = err;
    this.items.length = 0;
    if (this.failWaiter) {
      const f = this.failWaiter;
      this.waiter = null;
      this.failWaiter = null;
      f(err);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const queued = this.items.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.error) throw this.error;
      if (this.done) return;
      const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
        this.waiter = resolve;
        this.failWaiter = reject;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
