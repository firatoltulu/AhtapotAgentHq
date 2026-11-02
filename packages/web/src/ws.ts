import { useEffect, useRef, useState } from "react";

import { ServerEventSchema, type ServerEvent } from "@ahtapot/shared";

/**
 * İş olay akışı — dikişsiz yeniden bağlanma.
 *
 * Her olayın `seq`i tutulur; soket kopup gelince `subscribe{sinceSeq}` ile
 * kaçırılanlar replay edilir. `agent.delta` (seq 0) geçmişe yazılmaz: replay'de
 * yerini tamamlanmış `agent.message` alır, bu yüzden delta'lar ayrı tutulur ve
 * mesaj gelince temizlenir.
 *
 * `build.log` da AYRI tutulur ve aynı sebeple `seq: 0` gelir (sunucuda
 * ephemeral, bkz. `hub.ts` EPHEMERAL_TYPES). İki gerekçe:
 *
 *  1. Hacim: ölçüldü (2026-09-17) — olayların %93'ü build satırıydı. Aynı
 *     diziye girince `events` şişiyor ve her build satırı tüm ağacı yeniden
 *     render ediyordu; akış sekmesi build logunu atsa bile bedeli ödüyordu.
 *  2. `seq: 0` olduğu için `e.seq <= lastSeq` elemesine takılır ve sessizce
 *     düşerdi — ayrı yol zorunlu, tercih değil.
 *
 * Geçmiş build satırları REST'ten okunur (`builds.logRef` → log dosyası);
 * burada tutulan yalnız KOŞAN build'in canlı kuyruğudur.
 */

/** Bellekte tutulan canlı build satırı sayısı — eskisi log dosyasında. */
const BUILD_TAIL = 500;

export interface StreamState {
  events: ServerEvent[];
  /** runId → biriken canlı metin. */
  deltas: Record<string, string>;
  /** Koşan build'in son satırları; geçmişi REST'ten gelir. */
  buildLines: ServerEvent[];
  connected: boolean;
  lastSeq: number;
  /** İş silindi mi — `job.deleted` geldiğinde true, ekran hemen kapanmalı. */
  deleted: boolean;
}

export function useJobStream(jobId: string | null): StreamState {
  const [state, setState] = useState<StreamState>({
    events: [], deltas: {}, buildLines: [], connected: false, lastSeq: 0, deleted: false,
  });
  const lastSeq = useRef(0);

  useEffect(() => {
    if (!jobId) return;
    lastSeq.current = 0;
    setState({ events: [], deltas: {}, buildLines: [], connected: false, lastSeq: 0, deleted: false });

    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);

      ws.onopen = () => {
        attempt = 0;
        ws?.send(JSON.stringify({ type: "subscribe", jobId, sinceSeq: lastSeq.current }));
        setState((s) => ({ ...s, connected: true }));
      };

      ws.onmessage = (ev) => {
        let raw: unknown;
        try {
          raw = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        const parsed = ServerEventSchema.safeParse(raw);
        if (!parsed.success) return;
        const e = parsed.data;
        if (e.jobId !== jobId) return;

        if (e.type === "agent.delta") {
          setState((s) => ({ ...s, deltas: { ...s.deltas, [e.runId]: (s.deltas[e.runId] ?? "") + e.text } }));
          return;
        }
        if (e.type === "build.log") {
          // Kuyruk sınırlı: uzun build'de binlerce satır DOM'da kalmasın.
          setState((s) => ({ ...s, buildLines: [...s.buildLines, e].slice(-BUILD_TAIL) }));
          return;
        }
        if (e.type === "job.deleted") {
          // `seq: 0` — diğer olaylar gibi `lastSeq` karşılaştırmasına girmez
          // (agent.delta/build.log ile aynı sebep). İş zaten kalkıyor, akışın
          // geri kalanını beklemenin anlamı yok.
          setState((s) => ({ ...s, deleted: true }));
          return;
        }
        if (e.seq <= lastSeq.current) return; // replay tekrarı
        lastSeq.current = e.seq;
        setState((s) => {
          const deltas = { ...s.deltas };
          // Tamamlanmış mesaj geldi: canlı biriken metin artık gereksiz.
          if (e.type === "agent.message" || e.type === "agent.end") delete deltas[e.runId];
          return { ...s, events: [...s.events, e], deltas, lastSeq: e.seq };
        });
      };

      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (closed) return;
        const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt++, 5));
        setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [jobId]);

  return state;
}
