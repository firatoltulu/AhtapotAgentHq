import { and, eq, inArray } from "drizzle-orm";

import { type JobState, type ServerEvent } from "@ahtapot/shared";

import { type Db, schema } from "../db/index.js";
import { releaseLease, type LeaseKind } from "../resources/leases.js";
import type { EventHub } from "../ws/hub.js";
import { transition } from "./transition.js";

/**
 * Açılış uzlaştırması — çökme sonrası "nerede kalmıştık".
 *
 * Kural 2'nin karşılığı: her duruma `starting` ile girilir, iş sürerken
 * `running`. Süreç ölürse bunları tamamlayacak kimse yoktur; açılışta
 * görülen her `starting`/`running` iş yarıda kalmıştır ve sessizce
 * "çalışıyor" görünmek yerine NeedsAttention'a düşer. Yetim konteynerler
 * (işi bitmiş ya da hiç bilinmeyen) kaldırılır, bitmiş işlerin kiraları
 * serbest bırakılır.
 *
 * `engine/` Docker'ı bilmez: konteyner listesi ve kaldırma dar bir arayüzle
 * gelir; Docker yoksa o adım atlanır, DB uzlaştırması yine yapılır.
 */

export interface OrphanContainers {
  listOwned(): Promise<{ id: string; jobId: string; name: string; state: string }[]>;
  remove(jobId: string): Promise<boolean>;
  /** İş volume'ünü kaldırır (worktree orada yaşıyor). */
  removeVolume?(jobId: string): Promise<boolean>;
  /** Etiketli iş volume'leri — konteyneri çoktan gitmiş olanları bulmak için. */
  listOwnedVolumes?(): Promise<{ name: string; jobId: string }[]>;
}

export interface ReconcileReport {
  interruptedJobs: string[];
  releasedLeases: number;
  removedContainers: string[];
  /** Kaldırılan iş volume'leri (worktree diski). */
  removedVolumes: string[];
  /** Taşıma öncesi host yolu taşıdığı için sıfırlanan işler. */
  migratedWorktrees: string[];
  containerError: string | null;
}

const TERMINAL: readonly JobState[] = ["Done", "Cancelled"];
/** Konteyneri tutmaya değer durumlar: iş sürüyor ya da post-mortem bekliyor. */
const KEEPS_CONTAINER: readonly JobState[] = [
  "Developing", "Building", "LiveTest", "QACases", "QA", "PRReview", "CIWatch", "NeedsAttention",
];

export async function reconcile(
  db: Db,
  hub: EventHub | null,
  containers: OrphanContainers | null,
): Promise<ReconcileReport> {
  const report: ReconcileReport = { interruptedJobs: [], releasedLeases: 0, removedContainers: [], removedVolumes: [], migratedWorktrees: [], containerError: null };

  // 1) Yarıda kalan işler.
  const stuck = db
    .select({ id: schema.jobs.id, state: schema.jobs.state })
    .from(schema.jobs)
    .where(inArray(schema.jobs.phase, ["starting", "running"]))
    .all();
  for (const j of stuck) {
    const state = j.state as JobState;
    if (TERMINAL.includes(state) || state === "NeedsAttention") {
      db.update(schema.jobs).set({ phase: "waiting" }).where(eq(schema.jobs.id, j.id)).run();
      continue;
    }
    // NOT: Köprü henüz bağlanmadığı için konteynerde canlı koşu OLUP OLMADIĞI
    // burada bilinemez — köprü kendi backoff'uyla saniyeler sonra gelir. İş
    // yine `NeedsAttention`a alınır (kural 2: sessizce "çalışıyor" görünmesin),
    // ama bu geri alınabilir: köprü `bridge.hello`da `activeRunId` bildirirse
    // `app.ts` işi eski durumuna döndürüp akışı devralır.
    const recorded: ServerEvent[] = [];
    // Hata alanları geçişle AYNI transaction'da: geçiş geri alınırsa iş eski
    // durumunda ama "interrupted" damgasıyla kalmasın.
    transition(db, { jobId: j.id, to: "NeedsAttention", phase: "waiting", reason: "sunucu yeniden başladı", actorType: "system" }, (tx) => {
      tx.update(schema.jobs)
        .set({ errorCode: "interrupted", errorMessage: `sunucu yeniden başladı; iş ${state} içinde yarıda kaldı` })
        .where(eq(schema.jobs.id, j.id)).run();
      if (hub) recorded.push(hub.record(j.id, { type: "job.state", state: "NeedsAttention", phase: "waiting", loopCounts: {} }, tx));
    });
    for (const e of recorded) hub?.emit(e);
    report.interruptedJobs.push(j.id);
  }

  // 1b) ONAYLANMIŞ AMA İLERLEMEMİŞ kapılar.
  //
  // `decidePhase` onayı DB'ye yazar, sonra `runDeveloping`i arka planda
  // başlatır. Sunucu o iki adım arasında ölürse onay kalıcıdır ama sonraki
  // safha hiç başlamaz — ve iş `waiting`'de kaldığı için yukarıdaki tarama
  // (yalnız `starting`/`running`) onu GÖRMEZ.
  //
  // YAŞANDI (2026-09-17): iki iş `Developing/waiting`de 8,5 saat bekledi;
  // safhaları `approved`, son olayları onay anındaki `approval.required`.
  // Hiçbir kurtarma yolu onları görmüyordu: `retry()` yalnız `NeedsAttention`
  // kabul ediyor.
  //
  // Burada iş `NeedsAttention`a alınır — `retry()` görebilsin diye. Sessiz
  // bekleme yerine görünür bir kapı: kural 2'nin aynı gerekçesi.
  const idle = db
    .select({ id: schema.jobs.id, state: schema.jobs.state })
    .from(schema.jobs)
    // QACases: sıfır case'li onay kapıyı `approved` yazıp sonra hata
    // fırlatıyordu; iş kapısız `waiting`de kilitli kaldı (yaşandı). Buraya
    // düşen iş "Yeniden aç → QACases" ile listeyi yeniden alır.
    .where(and(eq(schema.jobs.phase, "waiting"), inArray(schema.jobs.state, ["Developing", "Building", "QACases"])))
    .all();
  for (const j of idle) {
    const pending = db
      .select({ id: schema.approvals.id })
      .from(schema.approvals)
      .where(and(eq(schema.approvals.jobId, j.id), eq(schema.approvals.status, "pending")))
      .all();
    // Bekleyen kapı VARSA iş gerçekten insanı bekliyor: dokunulmaz.
    if (pending.length > 0) continue;

    const recorded: ServerEvent[] = [];
    transition(
      db,
      { jobId: j.id, to: "NeedsAttention", phase: "waiting", reason: "onay sonrası ilerleme yok", actorType: "system" },
      (tx) => {
        tx.update(schema.jobs)
          .set({
            errorCode: "interrupted",
            errorMessage: "safha onaylandı ama sonraki adım başlamadı (sunucu onay ile geliştirme arasında düştü); yeniden dene",
          })
          .where(eq(schema.jobs.id, j.id)).run();
        if (hub) recorded.push(hub.record(j.id, { type: "job.state", state: "NeedsAttention", phase: "waiting", loopCounts: {} }, tx));
      },
    );
    for (const e of recorded) hub?.emit(e);
    report.interruptedJobs.push(j.id);
  }

  // 1b') Sahipsiz canlı test senaryosu istekleri. İş durumuna dokunmayan bir
  // yan koşu; süreç öldüyse sonucu yazacak kimse yok ve UI "üretiliyor"da
  // sonsuza dek bekler (kural 2'nin aynı gerekçesi).
  db.update(schema.testScenarios)
    .set({ status: "failed", error: "sunucu yeniden başladı; senaryolar yarıda kaldı" })
    .where(eq(schema.testScenarios.status, "running")).run();

  // 1b'') Sahipsiz ikinci göz eleştirileri (§42) — aynı gerekçe.
  db.update(schema.critiques)
    .set({ status: "failed", error: "sunucu yeniden başladı; eleştiri yarıda kaldı", finishedAt: new Date().toISOString() })
    .where(eq(schema.critiques.status, "running")).run();

  // 1c) TAŞIMA ÖNCESİ worktree yolları.
  //
  // Worktree named volume'e taşındı (2026-09-17): yollar artık konteyner içi
  // (`/workspace/<repo>`). Taşımadan ÖNCE açılmış işler host yolu taşıyor
  // (`E:\AhtapotData\worktrees\...`) ve o yol `docker exec`e gidince
  // "Cwd must be an absolute path" ile düşüyor — süreç çöküyordu (yaşandı).
  //
  // Yol YENİDEN YAZILMAZ: volume'de o ağaç yok, yazmak işi "hazır" gösterip
  // bir sonraki adımda daha derin bir hataya götürürdü. İş NeedsAttention'a
  // alınır ve gerekçesi söylenir; `retry()` worktree'yi volume'de kurar.
  const legacy = db
    .select({ id: schema.jobs.id, state: schema.jobs.state, path: schema.jobs.worktreePath })
    .from(schema.jobs)
    .all()
    .filter((j) => j.path !== null && !j.path.startsWith("/") && !TERMINAL.includes(j.state as JobState));
  for (const j of legacy) {
    // ZATEN NeedsAttention ise geçiş YAPILMAZ: kendine geçişi durum makinesi
    // reddeder ve açılış çöker. Yalnız yol sıfırlanır — `retry()` için yeterli.
    if ((j.state as JobState) === "NeedsAttention") {
      db.update(schema.jobs)
        .set({
          worktreePath: null,
          errorCode: "worktree_migrated",
          errorMessage:
            "Çalışma ağacı named volume'e taşındı; bu iş eski host yolunu taşıyordu. Yeniden dene — ağaç volume'de kurulacak.",
        })
        .where(eq(schema.jobs.id, j.id)).run();
      report.migratedWorktrees.push(j.id);
      continue;
    }
    const recorded: ServerEvent[] = [];
    transition(
      db,
      { jobId: j.id, to: "NeedsAttention", phase: "waiting", reason: "worktree taşındı", actorType: "system" },
      (tx) => {
        tx.update(schema.jobs)
          .set({
            worktreePath: null,
            errorCode: "worktree_migrated",
            errorMessage:
              "Çalışma ağacı named volume'e taşındı; bu iş eski host yolunu taşıyordu. Yeniden dene — ağaç volume'de kurulacak.",
          })
          .where(eq(schema.jobs.id, j.id)).run();
        if (hub) recorded.push(hub.record(j.id, { type: "job.state", state: "NeedsAttention", phase: "waiting", loopCounts: {} }, tx));
      },
    );
    for (const e of recorded) hub?.emit(e);
    report.migratedWorktrees.push(j.id);
  }

  // 2) Bitmiş işlerin kiraları. NeedsAttention'ınki KALIR: post-mortem için
  //    worktree ve konteyner yerinde durmalı.
  const finished = db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(inArray(schema.jobs.state, [...TERMINAL]))
    .all();
  const finishedIds = new Set(finished.map((f) => f.id));
  if (finishedIds.size > 0) {
    const leases = db
      .select({ jobId: schema.resourceLeases.jobId, kind: schema.resourceLeases.kind, value: schema.resourceLeases.value })
      .from(schema.resourceLeases)
      .where(and(eq(schema.resourceLeases.state, "held"), inArray(schema.resourceLeases.jobId, [...finishedIds])))
      .all();
    for (const l of leases) {
      if (releaseLease(db, l.kind as LeaseKind, l.value)) report.releasedLeases++;
    }
  }

  // 2b) SÜRESİ DOLMUŞ kiralar.
  //
  // Kiranın `expires_at`i var ama hiçbir yer onu OKUMUYORDU: yalnız bitmiş
  // işlerin kiraları bırakılıyordu. Canlı ortam `unhealthy` kalıp hiç
  // `stop()` edilmezse kira asılı kalır ve compose projesi adı iş başına
  // sabit olduğu için o iş bir daha ortam kaldıramaz — kendi kendine
  // çıkamayan bir kilit (yaşandı 2026-09-17: 08:20'de alınan kira 12:03'teki
  // koşuyu düşürdü, TTL 10:20'de dolmuştu).
  const now = new Date().toISOString();
  const expired = db
    .select({ kind: schema.resourceLeases.kind, value: schema.resourceLeases.value, expiresAt: schema.resourceLeases.expiresAt })
    .from(schema.resourceLeases)
    .where(eq(schema.resourceLeases.state, "held"))
    .all()
    .filter((l) => l.expiresAt !== null && l.expiresAt < now);
  for (const l of expired) {
    if (releaseLease(db, l.kind as LeaseKind, l.value)) report.releasedLeases++;
  }

  // 3) Yetim konteynerler: işi yok, bitmiş ya da konteyner istemeyen durumda.
  if (containers) {
    const errors: string[] = [];
    try {
      const owned = await containers.listOwned();
      const states = new Map(
        db.select({ id: schema.jobs.id, state: schema.jobs.state }).from(schema.jobs).all().map((j) => [j.id, j.state as JobState]),
      );
      for (const c of owned) {
        const state = states.get(c.jobId);
        const keep = state !== undefined && KEEPS_CONTAINER.includes(state);
        if (keep) continue;
        // Biri kaldırılamazsa diğerleri yine denenir; sonraki deneme ancak yeniden açılışta.
        try {
          if (await containers.remove(c.jobId)) report.removedContainers.push(c.name);
          // Konteyner gitti: iş volume'ü de gitmeli, yoksa worktree'ler diskte
          // birikir. Sıra önemli — kullanımdaki volume silinemez.
          if (await containers.removeVolume?.(c.jobId)) report.removedVolumes.push(c.jobId);
        } catch (err) {
          errors.push(`${c.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // 3b) Konteyneri çoktan gitmiş ama volume'ü kalmış işler.
      //
      // Worktree artık volume'de yaşıyor: konteyner kaldırıldıktan sonra
      // volume arkada kalırsa Northwind boyutunda bir ağaç diskte birikir ve
      // hiçbir yerden görünmez (host'ta dizin yok). Yukarıdaki döngü yalnız
      // konteyneri VAR olanları görür.
      try {
        const vols = (await containers.listOwnedVolumes?.()) ?? [];
        for (const v of vols) {
          if (!v.jobId) continue;
          const state = states.get(v.jobId);
          if (state !== undefined && KEEPS_CONTAINER.includes(state)) continue;
          if (report.removedVolumes.includes(v.jobId)) continue;
          // Hâlâ kullanımdaysa Docker reddeder; `removeVolume` false döner.
          if (await containers.removeVolume?.(v.jobId)) report.removedVolumes.push(v.jobId);
        }
      } catch (err) {
        errors.push(`volume taraması: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      // Docker yoksa DB uzlaştırması yine geçerli; sessizce yutma, raporla.
      errors.push(err instanceof Error ? err.message : String(err));
    }
    if (errors.length > 0) report.containerError = errors.join("; ");
  }

  return report;
}
