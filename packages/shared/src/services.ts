import type { ProjectProfile, Service } from "./profile.js";

/**
 * Üst düzey `services` kataloğundan ad çözümü.
 *
 * Canlı ortam ve test takımları servisi ADIYLA ister; tanım tek yerde durur.
 * Bulunamayan ad sessizce düşmez — çağıran `missing`i kullanıcıya göstermeli.
 */

export function serviceByName(profile: ProjectProfile, name: string): Service | null {
  return profile.services.find((s) => s.name === name) ?? null;
}

export function resolveServices(profile: ProjectProfile, names: readonly string[]): { found: Service[]; missing: string[] } {
  const found: Service[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const svc = serviceByName(profile, name);
    if (svc) found.push(svc);
    else missing.push(name);
  }
  return { found, missing };
}

/**
 * Servise nereden bağlanılır.
 *
 * Dışarıdaysa host `externalHost`, port host tarafındaki port; compose
 * ağındaysa host servis adı, port konteynerin kendi portu. İkisinde de 5432
 * gibi bir sabite düşmek yanlıştı: 5432 dinlemeyen bir Postgres tanımında
 * bağlantı dizesi sessizce hatalı çıkıyordu.
 */
export function serviceAddress(svc: Service): { host: string; port: number } {
  return svc.externalHost
    ? { host: svc.externalHost, port: svc.externalPort ?? svc.internalPort }
    : { host: svc.name, port: svc.internalPort };
}

/** `redis-cache` → `AHTAPOT_SVC_REDIS_CACHE` (sonuna `_HOST` / `_PORT` eklenir). */
export function serviceEnvPrefix(name: string): string {
  return `AHTAPOT_SVC_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}
