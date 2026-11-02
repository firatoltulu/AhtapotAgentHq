import { z } from "zod";

import { ProjectProfileSchema } from "@ahtapot/shared";

/**
 * ProjectProfileSchema'yı (773 satır, 18 alt-şema) gezip UI-nötr bir alan
 * ağacına çeviren introspection katmanı.
 *
 * Zod v4 API'si (v3'ten farklı — `.def.type` string tabanlı, `._def` DEĞİL):
 * doğrulama `node -e` ile yapıldı (zod@4.6.4):
 *   object → .shape · array → .def.element · enum → .def.entries/.options
 *   record → .def.keyType/.def.valueType (.def.partial → partialRecord ayrımı)
 *   optional/nullable/default/prefault → .def.innerType (default/prefault
 *   ayrıca .def.defaultValue taşır) · literal → .def.values (dizi).
 *
 * Neden burada, shared'da değil: çıktı (FieldSpec) tamamen UI kaygısı —
 * shared yalnız şemayı sağlar, formu nasıl çizeceğini bilmez.
 */

export type FieldKind = "string" | "number" | "boolean" | "enum" | "literal" | "object" | "array" | "record";

export interface FieldSpec {
  /** Bu düğümün obje içindeki anahtarı; kök için "". */
  key: string;
  kind: FieldKind;
  /** `.optional()` sarmalı var mı — value `undefined` olabilir. */
  isOptional: boolean;
  /**
   * `.nullable()` sarmalı var mı — value `null` olabilir ve bu `undefined`dan
   * FARKLI bir anlam taşır (ör. `approvalRequiredFrom: null` = "onay
   * gerekmiyor", `.default("frontier")` yalnız alan HİÇ verilmezse devreye
   * girer). `unwrap` eskiden `optional`/`nullable`i tek bayrakta (isOptional)
   * topluyordu — `null` bilgisi kayboluyor, `enum` widget'ı ilk seçeneği
   * (`cheap`) gösteriyordu (CodeRabbit, gerçek anlam kaybı).
   */
  isNullable: boolean;
  /** `.default()`/`.prefault()` var mı. */
  hasDefault: boolean;
  defaultValue: unknown;
  /** kind === "enum" | "literal" */
  enumValues?: string[];
  /** kind === "object" */
  shape?: Record<string, FieldSpec>;
  /** kind === "array" | "record" — eleman/value tipi. */
  element?: FieldSpec;
  /** kind === "record" && enum-keyed (partialRecord) — anahtarlar sabit. */
  recordKeyEnum?: string[];
  /** Fallback/ham erişim için — introspection eksik kalırsa buradan devam edilebilir. */
  zodType: z.ZodType;
}

interface UnwrapResult {
  inner: z.ZodType;
  isOptional: boolean;
  isNullable: boolean;
  hasDefault: boolean;
  defaultValue: unknown;
}

/**
 * `optional`/`nullable`/`default`/`prefault` katmanlarını recursive soyar.
 * `optional` ve `nullable` AYRI bayraklarda tutulur — ikisi farklı çalışma
 * zamanı değeri taşır (`undefined` vs `null`), birbirinin yerine geçmez.
 * Sıra önemsiz: `default(optional(...))` de `optional(default(...))` de aynı
 * sonuca iner — hangi bayrak önce görülürse o kalıcı sayılır (ilk `true` kazanır).
 */
function unwrap(schema: z.ZodType): UnwrapResult {
  let cur: z.ZodType = schema;
  let isOptional = false;
  let isNullable = false;
  let hasDefault = false;
  let defaultValue: unknown;

  for (;;) {
    const type = (cur as unknown as { def: { type: string } }).def.type;
    if (type === "optional") {
      isOptional = true;
      cur = (cur as unknown as { def: { innerType: z.ZodType } }).def.innerType;
      continue;
    }
    if (type === "nullable") {
      isNullable = true;
      cur = (cur as unknown as { def: { innerType: z.ZodType } }).def.innerType;
      continue;
    }
    // `z.preprocess` (eski profil biçimini çeviren kök sarmal) bir `pipe`
    // üretir; formun çizeceği şey çıkış tarafındaki şemadır.
    if (type === "pipe") {
      cur = (cur as unknown as { def: { out: z.ZodType } }).def.out;
      continue;
    }
    if (type === "default" || type === "prefault") {
      hasDefault = true;
      const def = (cur as unknown as { def: { innerType: z.ZodType; defaultValue: unknown } }).def;
      defaultValue = def.defaultValue;
      cur = def.innerType;
      continue;
    }
    break;
  }
  return { inner: cur, isOptional, isNullable, hasDefault, defaultValue };
}

export function introspect(schema: z.ZodType, key = ""): FieldSpec {
  const { inner, isOptional, isNullable, hasDefault, defaultValue } = unwrap(schema);
  const def = (inner as unknown as { def: Record<string, unknown> }).def;
  const type = def["type"] as string;

  const base = { key, isOptional, isNullable, hasDefault, defaultValue, zodType: inner };

  switch (type) {
    case "object": {
      const shapeRaw = (inner as unknown as { shape: Record<string, z.ZodType> }).shape;
      const shape: Record<string, FieldSpec> = {};
      for (const [k, v] of Object.entries(shapeRaw)) shape[k] = introspect(v, k);
      return { ...base, kind: "object", shape };
    }
    case "array": {
      const element = def["element"] as z.ZodType;
      return { ...base, kind: "array", element: introspect(element, "") };
    }
    case "record": {
      const valueType = def["valueType"] as z.ZodType;
      const keyType = def["keyType"] as z.ZodType;
      const keyDef = (keyType as unknown as { def: Record<string, unknown> }).def;
      // partialRecord de def.type === "record" üretir; .def.partial bayrağı ve
      // anahtar tipinin enum olması onu "sabit anahtarlı" record ayırt eder.
      const recordKeyEnum = keyDef["type"] === "enum" ? (keyType as unknown as { options: string[] }).options : undefined;
      return { ...base, kind: "record", element: introspect(valueType, ""), ...(recordKeyEnum ? { recordKeyEnum } : {}) };
    }
    case "enum": {
      const options = (inner as unknown as { options: string[] }).options;
      return { ...base, kind: "enum", enumValues: options };
    }
    case "literal": {
      const values = def["values"] as unknown[];
      return { ...base, kind: "literal", enumValues: values.map(String) };
    }
    case "string":
      return { ...base, kind: "string" };
    case "number":
    case "int":
      return { ...base, kind: "number" };
    case "boolean":
      return { ...base, kind: "boolean" };
    default:
      // Bilinmeyen bir Zod düğümü (yeni bir tip eklendi vs.) — form kırılmasın,
      // salt metin alanı gibi davran; zodType her zaman fallback için saklı.
      return { ...base, kind: "string" };
  }
}

export const PROFILE_FORM_SCHEMA: FieldSpec = introspect(ProjectProfileSchema, "");
