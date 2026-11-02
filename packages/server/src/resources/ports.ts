import { createServer } from "node:net";

import { and, eq } from "drizzle-orm";

import { schema, type Db } from "../db/index.js";
import { acquireLease, heldLeases, LeaseConflict, releaseLease } from "./leases.js";

/**
 * Port havuzu — canlı ortamlar için host portları.
 *
 * İki kaynak birden doğrulanır: kira tablosu (başka iş almış mı) VE gerçek
 * bağlanabilirlik (host'ta başka bir şey dinliyor mu). İkincisi Windows'ta
 * şart: WinNAT/Hyper-V bazı aralıkları "excluded port range" olarak
 * kapatıyor ve `bind` EACCES ile düşüyor — kira tablosu bunu bilemez.
 * Ölçmeden tahsis etmek, canlı ortamı "port çakıştı" ile başlatma anında
 * düşürür.
 */

export interface PortRange {
  from: number;
  to: number;
}

export class PortsExhausted extends Error {
  constructor(range: PortRange, wanted: number) {
    super(`boş port kalmadı: ${range.from}-${range.to} aralığında ${wanted} port istendi`);
    this.name = "PortsExhausted";
  }
}

/** Port host'ta gerçekten bağlanabilir mi? (EADDRINUSE, EACCES → hayır) */
export function probePort(port: number, host = "0.0.0.0"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

export class PortPool {
  constructor(
    private readonly db: Db,
    private readonly range: PortRange,
    private readonly probe: (port: number) => Promise<boolean> = probePort,
  ) {
    if (range.from > range.to || range.from < 1 || range.to > 65535) {
      throw new Error(`geçersiz port aralığı: ${range.from}-${range.to}`);
    }
  }

  /**
   * `count` port kiralar; hepsi ya da hiçbiri. Aday sırayla denenir: kira
   * tablosunda tutuluyorsa atlanır, bağlanamıyorsa atlanır, kira yarışını
   * kaybederse (paralel istek) atlanır.
   */
  async acquire(jobId: string, count = 1): Promise<number[]> {
    const held = new Set(
      this.db
        .select({ value: schema.resourceLeases.value })
        .from(schema.resourceLeases)
        .where(and(eq(schema.resourceLeases.kind, "port"), eq(schema.resourceLeases.state, "held")))
        .all()
        .map((l) => Number(l.value)),
    );
    const got: number[] = [];
    // Hepsi ya da hiçbiri: yarım tahsis kalıcı sızıntıdır. Beklenmeyen hata
    // (probe reddi, DB hatası) da aynı yoldan geri alınır; özgün hata korunur.
    const rollback = () => {
      for (const p of got) {
        try {
          releaseLease(this.db, "port", String(p));
        } catch {
          /* temizleme hatası özgün hatayı maskelemesin */
        }
      }
    };
    try {
      for (let port = this.range.from; port <= this.range.to && got.length < count; port++) {
        if (held.has(port)) continue;
        if (!(await this.probe(port))) continue;
        try {
          acquireLease(this.db, { jobId, kind: "port", value: String(port) });
          got.push(port);
        } catch (err) {
          if (err instanceof LeaseConflict) continue;
          throw err;
        }
      }
    } catch (err) {
      rollback();
      throw err;
    }
    if (got.length < count) {
      rollback();
      throw new PortsExhausted(this.range, count);
    }
    return got;
  }

  /** İşin tuttuğu tüm portları bırakır; bırakılan port sayısı döner. */
  release(jobId: string): number {
    let n = 0;
    for (const lease of heldLeases(this.db, jobId, "port")) {
      if (releaseLease(this.db, "port", lease.value)) n++;
    }
    return n;
  }

  /** İşin tuttuğu portlar (UI ve canlı ortam kurulumu için). */
  held(jobId: string): number[] {
    return heldLeases(this.db, jobId, "port").map((l) => Number(l.value)).sort((a, b) => a - b);
  }
}
