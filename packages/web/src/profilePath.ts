/**
 * Profil formu için path-tabanlı immutable get/set — formun tek state motoru.
 *
 * Her `SchemaField.onChange(path, value)` çağrısı kök bileşende
 * `setDraft(d => setAtPath(d, path, value))` olarak uygulanır. Immutable:
 * yol üzerindeki her seviye shallow-copy edilir (obje spread / dizi slice),
 * yol dışındaki dallar aynı referansı korur — React'in değişiklik algısı
 * (Object.is) bununla çalışır.
 */

export type PathSegment = string | number;

export function getAtPath(obj: unknown, path: PathSegment[]): unknown {
  let cur = obj;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<PathSegment, unknown>)[seg];
  }
  return cur;
}

export function setAtPath<T>(obj: T, path: PathSegment[], value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path as [PathSegment, ...PathSegment[]];

  if (typeof head === "number") {
    const arr = Array.isArray(obj) ? [...obj] : [];
    arr[head] = setAtPath(arr[head], rest, value);
    return arr as unknown as T;
  }

  const record = obj && typeof obj === "object" ? { ...(obj as Record<string, unknown>) } : {};
  record[head] = setAtPath(record[head], rest, value);
  return record as unknown as T;
}

/** Dizi elemanını siler — indeksleri kaydırır (splice), `undefined` bırakmaz. */
export function removeAtPath<T>(obj: T, path: PathSegment[]): T {
  if (path.length === 0) return obj;
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1]!;
  const parent = getAtPath(obj, parentPath);

  if (typeof last === "number" && Array.isArray(parent)) {
    const arr = [...parent];
    arr.splice(last, 1);
    return setAtPath(obj, parentPath, arr);
  }
  if (typeof last === "string" && parent && typeof parent === "object") {
    const record = { ...(parent as Record<string, unknown>) };
    delete record[last];
    return setAtPath(obj, parentPath, record);
  }
  return obj;
}
