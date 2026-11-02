import { and, asc, eq, gt, desc } from "drizzle-orm";

import { scrubSecrets, type ServerEvent } from "@ahtapot/shared";

import { newId, type Db, type Executor, schema } from "../db/index.js";
import { nextEventSeq } from "../engine/transition.js";

/**
 * WebSocket hub — iş odaları, olay kalıcılığı ve replay.
 *
 * Üç kural buradan gelir:
 *
 *  1. KALICILIK: her olay `job_events`e yazılır ve monoton bir `seq` taşır.
 *     İstemci yeniden bağlanırken `sinceSeq` gönderir; tarayıcı sekmesi
 *     uyuduğunda 20 dakikalık bir agent turu kaybolmamalı.
 *
 *  2. DELTA İSTİSNASI: `agent.delta` (token akışı) DB'ye YAZILMAZ. Hacmi çok
 *     yüksek ve replay'de değeri yok — tamamlanmış `agent.message` zaten nihai
 *     içeriği taşıyor. Canlı izleyiciye gönderilir, geçmişe yazılmaz.
 *
 *  3. MASKELEME: dışarı çıkan her metin `scrubSecrets`ten geçer. Log'lar hem
 *     DB'de saklanıyor hem UI'da gösteriliyor; bu bir sigorta değil zorunluluk.
 */

/** Hub'ın tanıdığı en küçük soket arayüzü — test edilebilirlik için. */
export interface Socket {
  send(data: string): void;
  readonly bufferedAmount?: number;
}

/**
 * Zarf alanları (`seq`, `jobId`, `at`) hub tarafından doldurulur; çağıran
 * yalnız olayın kendi gövdesini verir.
 *
 * `Omit` doğrudan bir birleşime uygulandığında birleşim DAĞILMAZ ve ortak
 * alanlara indirgenir — `state`, `runId` gibi tipe özel alanlar kaybolur.
 * Koşullu tip üzerinden dağıtım bunu önler.
 */
type EventBody<T> = T extends ServerEvent ? Omit<T, "seq" | "jobId" | "at"> : never;
export type PublishInput = EventBody<ServerEvent>;

interface Subscriber {
  socket: Socket;
  jobId: string;
}

/** Yavaş istemcide hacimli olay atlama eşiği (bayt). */
const BACKPRESSURE_LIMIT = 1_000_000;

/**
 * DB'ye YAZILMAYAN olay tipleri — hacimli akışlar.
 *
 * Kural 7'nin genişletilmiş hâli. `agent.delta` token akışı olduğu için
 * baştan buradaydı; `build.log` ÖLÇÜLDÜ (2026-09-17, çalışan kurulum):
 * 28.303 olayın 26.404'ü (%93) ve 12,46 MB'ın 10,82 MB'ı (%87) build
 * satırıydı. Büyük işlerde oran %97-98.
 *
 * Sonucu yalnız disk değildi: ilk abonelikte dönen `REPLAY_LIMIT` olayın
 * ~%97'si build satırı olduğu için akış sekmesinde agent'ın 38 dakikalık
 * turundan geriye ~17 olay kalıyordu — "agent'ın ne yaptığını izleyemiyorum".
 *
 * Veri KAYBOLMUYOR: build logu `gate.ts` tarafından
 * `<artifactsDir>/<jobId>/build-<buildId>.log` altına tam yazılıyor ve
 * `builds.logRef` onu işaret ediyor. Canlı yayın da sürüyor — koşan build
 * anlık izlenir, geçmişi dosyadan okunur.
 *
 * `job.deleted` de burada — DB'YE YAZILMAZ ama nedeni farklı: job zaten
 * siliniyor, `job_events`e yazacak satır kalmıyor. Bu iki farklı gerekçe
 * (hacim vs. "hedef satır yok") aynı sette toplanıyor çünkü ikisi de "DB'ye
 * yazma" sorusuna aynı cevabı veriyor — YAYIN önceliği ayrı, bkz. `LOSSY_TYPES`.
 */
const EPHEMERAL_TYPES = new Set(["agent.delta", "build.log", "job.deleted"]);

/**
 * Yavaş istemcide ATLANABİLİR olay tipleri — `EPHEMERAL_TYPES`den FARKLI soru.
 *
 * `agent.delta`/`build.log` kaybolursa zararsız: animasyon seyrelir, nihai
 * içerik (agent.message / build tamamlanınca REST) zaten geliyor. `job.deleted`
 * KAYBOLURSA istemci işin silindiğini hiç öğrenmez — CodeRabbit'in bulduğu
 * kusur (2026-09-19): `job.deleted` `EPHEMERAL_TYPES`e girince backpressure
 * atlamasına da otomatik dahil olmuştu, oysa "DB'ye yazılmasın" ile "yavaş
 * istemciye göndermeyi atla" ayrı kararlar.
 */
const LOSSY_TYPES = new Set(["agent.delta", "build.log"]);

/**
 * İlk abonelikte geri verilen olay sayısı — **en yeniler**.
 *
 * 250, bir ekran doluşunun birkaç katı: operatör "en son ne oldu" sorusunun
 * cevabını görür, tarayıcıya binlerce satır çizdirmeden. Daha eskisi log
 * dosyasında duruyor; burada amaç arşiv değil, canlı takip.
 */
const REPLAY_LIMIT = 250;

export class EventHub {
  private readonly rooms = new Map<string, Set<Subscriber>>();
  private readonly listeners = new Set<(event: ServerEvent) => void>();

  constructor(private readonly db: Db) {}

  subscribe(jobId: string, socket: Socket): Subscriber {
    const sub: Subscriber = { socket, jobId };
    let room = this.rooms.get(jobId);
    if (!room) {
      room = new Set();
      this.rooms.set(jobId, room);
    }
    room.add(sub);
    return sub;
  }

  unsubscribe(sub: Subscriber): void {
    const room = this.rooms.get(sub.jobId);
    if (!room) return;
    room.delete(sub);
    if (room.size === 0) this.rooms.delete(sub.jobId);
  }

  subscriberCount(jobId: string): number {
    return this.rooms.get(jobId)?.size ?? 0;
  }

  /**
   * Olayı kalıcılaştırır ve odaya yayar.
   *
   * `seq` ve `at` burada üretilir: çağıranın bunları doğru doldurması
   * beklenmez, çünkü sıra numarasının biricikliği DB'ye dayanır.
   */
  publish(jobId: string, event: PublishInput): ServerEvent {
    const recorded = this.record(jobId, event);
    this.emit(recorded);
    return recorded;
  }

  /**
   * Yalnız kalıcılaştırır — yayın yok.
   *
   * Durum geçişiyle birlikte yazılması gereken olay için: `exec` olarak açık
   * transaction verilir, olay durumla aynı commit'te kalıcılaşır. Yayın commit
   * SONRASINDA `emit` ile yapılır; aksi hâlde istemci var olmayan bir duruma
   * göre çizer.
   */
  record(jobId: string, event: PublishInput, exec: Executor = this.db): ServerEvent {
    const ephemeral = EPHEMERAL_TYPES.has(event.type);
    const seq = ephemeral ? 0 : nextEventSeq(exec, jobId);
    const full = {
      ...event,
      seq,
      jobId,
      at: new Date().toISOString(),
    } as ServerEvent;

    const scrubbed = scrubEvent(full);

    if (!ephemeral) {
      exec
        .insert(schema.jobEvents)
        .values({
          id: newId(),
          jobId,
          seq,
          type: scrubbed.type,
          payload: scrubbed as never,
        })
        .run();
    }
    return scrubbed;
  }

  /** Kaydedilmiş olayı canlı izleyicilere yayar. */
  emit(event: ServerEvent): void {
    this.broadcast(event.jobId, event, LOSSY_TYPES.has(event.type));
    for (const fn of this.listeners) {
      // Dinleyici (bildirim) düşerse yayın ve motor etkilenmemeli.
      try {
        fn(event);
      } catch {
        /* dinleyici kendi hatasını loglar */
      }
    }
  }

  /**
   * Oda dışı dinleyici — soket değil, süreç içi tüketici (push bildirimi).
   *
   * `emit` üzerinden bağlanır, `record` üzerinden DEĞİL: transaction içinde
   * kaydedilen olay commit'ten önce dışarı bildirilmemeli (bkz. `record`).
   * Olay zaten maskelenmiş gelir.
   */
  onEmit(fn: (event: ServerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private broadcast(jobId: string, event: ServerEvent, lossy: boolean): void {
    const room = this.rooms.get(jobId);
    if (!room || room.size === 0) return;

    const payload = JSON.stringify(event);
    for (const sub of room) {
      // Yavaş istemcide YALNIZ delta/build.log atlanır: animasyon seyrelir
      // ama nihai içerik (agent.message) her zaman gider. `job.deleted` bu
      // kategoride DEĞİL — kaybolursa istemci işin silindiğini öğrenemez.
      if (lossy && (sub.socket.bufferedAmount ?? 0) > BACKPRESSURE_LIMIT) continue;
      try {
        sub.socket.send(payload);
      } catch {
        // Kopmuş soket yayını engellememeli; temizliği close olayı yapar.
        this.rooms.get(jobId)?.delete(sub);
      }
    }
  }

  /**
   * `sinceSeq`ten sonraki olayları döndürür — sınıra takılırsa **SON** `limit` tanesi.
   *
   * Delta'lar geçmişte yok; istemci yeniden bağlandığında akışı tamamlanmış
   * mesajlarla yeniden kurar. Bu bilinçli bir takas: animasyon kaybı var,
   * içerik kaybı yok.
   *
   * Sıralama `desc` + sonda ters çevirme: `asc ... LIMIT n` BAŞTAN keser ve
   * kullanıcı tam da en yeni satırları göremez. Ölçüldü — 1583 olaylı bir işte
   * ilk 1000'i gönderen sürüm 433 `build.log` ve üç `job.error` olayını hiç
   * göstermedi; iş "koşuyor" görünürken hatalar ekrana hiç ulaşmamıştı.
   *
   * Kesme YALNIZ ilk aboneliğe (sinceSeq=0) uygulanır. Yeniden bağlanan
   * istemciye `desc ... LIMIT n` uygulamak BOŞLUK açar: istemci 500'den
   * sonrasını isterken arada 400 olay birikmişse sorgu en yeni 250'yi döndürür
   * ve 501-650 arası hiç gitmez. İstemci `seq`i monoton artan bekler; boşluk
   * gören akış "mesaj alınamıyor" ile durur (yaşandı, 2026-09-17 — build
   * logları saniyede yüzlerce olay üretiyor, 250'lik pencere anında doluyor).
   *
   * Artımlı istekte sıra `asc` ve limit yok: aradaki fark normalde küçüktür,
   * büyükse de eksiksiz gitmesi gerekir.
   */
  replay(jobId: string, sinceSeq: number, limit = REPLAY_LIMIT): ServerEvent[] {
    const base = this.db
      .select({ payload: schema.jobEvents.payload })
      .from(schema.jobEvents)
      .where(and(eq(schema.jobEvents.jobId, jobId), gt(schema.jobEvents.seq, sinceSeq)));

    if (sinceSeq > 0) {
      return base.orderBy(asc(schema.jobEvents.seq)).all().map((r) => r.payload as ServerEvent);
    }

    // İlk abonelik: en YENİ `limit` tanesi. `asc ... LIMIT n` baştan keser ve
    // kullanıcı tam da son satırları göremez (ölçüldü: 1583 olaylı işte 433
    // `build.log` ve üç `job.error` ekrana hiç ulaşmamıştı).
    const rows = base.orderBy(desc(schema.jobEvents.seq)).limit(limit).all();

    // Kronolojik sıraya geri dön: `lastSeq` mantığı azalan akışta ikinciden
    // itibaren hepsini yutardı.
    return rows.reverse().map((r) => r.payload as ServerEvent);
  }
}

/**
 * Olay içindeki serbest metinleri maskeler.
 *
 * ESKİDEN sabit bir alan listesi taranıyordu (`text`, `content`, `line`…) ve
 * yeni metin alanı eklendiğinde listeyi güncellemek unutuluyordu: `command`,
 * `cwd` ve araç alanları (`file`, `meta`, `diff`) maskelenmeden geçiyordu —
 * `.env` düzenleyen bir `Edit` olayı farkıyla birlikte sırrı hem DB'ye hem
 * UI'a taşırdı. Sessiz sızıntı, listeyi güncellemeyi hatırlamaya bağlı
 * olmamalı.
 *
 * Artık tersi: olaydaki HER dize taranır, yalnız maskelenmemesi gerekenler
 * dışarıda bırakılır. Yeni alan eklendiğinde varsayılan güvenli taraftır.
 */

/**
 * Maskelenmeyen alanlar — makine kimlikleri ve sabit sözlükler.
 *
 * Bunlar serbest metin değil: `scrubSecrets` bir `runId`yi ya da ISO damgayı
 * sır sanıp bozarsa akış eşleşmesi (`toolId` → sonuç) ve replay kırılır.
 */
const NEVER_SCRUB = new Set([
  "type",
  "jobId",
  "runId",
  "toolId",
  "gateId",
  "questionId",
  "at",
  "state",
  "phase",
  "role",
  "model",
  "sessionId",
  "subtype",
  "code",
  "stream",
  "kind",
  "elapsed",
  "name",
]);

/** Dize, dize dizisi ve dize demetlerini (fark satırları) derinlemesine maskeler. */
function scrubDeep(value: unknown): unknown {
  if (typeof value === "string") return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  return value;
}

function scrubEvent(event: ServerEvent): ServerEvent {
  const out = { ...event } as Record<string, unknown>;
  for (const [key, v] of Object.entries(out)) {
    if (NEVER_SCRUB.has(key)) continue;
    out[key] = scrubDeep(v);
  }
  return out as ServerEvent;
}
