/**
 * Build logu zaman damgası.
 *
 * `build.log` olayları ALTI ayrı yerden yayınlanıyor (build kapısı, test
 * koşucusu, ortam kurulumu…). Damgayı yalnız birine koymak logu yarı damgalı
 * bırakıyor ve en uzun süren adım — kurulum — damgasız kalıyordu (yaşandı).
 */

/**
 * Adım başlangıcından bu yana geçen süre — `m:ss.d` biçiminde.
 *
 * Mutlak saat değil GEÇEN SÜRE: "npm ci'nin 2. dakikasında asıldı" okunabilsin
 * diye. Mutlak damgadan bunu çıkarmak için her satırda adımın başlangıcını
 * bilmek gerekirdi.
 *
 * Dakika hanesi büyüdükçe yalnız sola taşar; saniye iki hane sabit kalır ve log
 * hizası uzun koşularda bozulmaz.
 */
export function elapsed(startedAt: number): string {
  const ms = Date.now() - startedAt;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}
