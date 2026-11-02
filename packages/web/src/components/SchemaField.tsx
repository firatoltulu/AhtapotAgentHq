import { useState, type ReactNode } from "react";

import type { FieldSpec } from "../profileSchema";
import { labelFor } from "../profileLabels";
import { getAtPath, removeAtPath, setAtPath, type PathSegment } from "../profilePath";
import { Button, Checkbox, Field, Input, Select, Textarea } from "../ui";
import type { SchemaFieldProps } from "./profile/types";
import { EnvTable } from "./profile/EnvTable";
import { FIELD_OVERRIDES, normalizePath } from "./profile/overrides";

export type { SchemaFieldProps };

/**
 * ProjectProfileSchema'dan üretilen `FieldSpec` ağacını gezip düzenlenebilir
 * form input'ları çizen genel motor. `ProfileEditor.tsx` bölüm bölüm çağırır.
 *
 * Path-bazlı özel widget yönlendirmesi (`FIELD_OVERRIDES`, `overrides.tsx`)
 * genel motordan ÖNCE denenir: `services` gibi "birlikte anlamlı"
 * alan grupları kart/tablo widget'ına düşer, geri kalan her şey burada
 * kind-bazlı dallanmayla çizilir — şemaya yeni alan eklenince otomatik kapsanır.
 *
 * `SchemaFieldProps` `./profile/types.ts`te tanımlı, burada değil: widget'lar
 * (`overrides.tsx` altındakiler) bu tipe ihtiyaç duyuyor ama `SchemaField`
 * modülünün TAMAMINA bağımlı olmamalı — `RolesEditor` gibi recursive render
 * yapanlar hariç, çoğu widget yalnız tipi kullanıyor. Tip ayrı dosyada olunca
 * o widget'lar gerçek bir modül döngüsüne girmiyor.
 */

/** Boş bir dizi elemanı/record value'su üretir — `defaultValue` varsa onu, yoksa kind'a göre iskelet. */
function emptyValueFor(spec: FieldSpec): unknown {
  if (spec.hasDefault) return spec.defaultValue;
  switch (spec.kind) {
    case "string":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "record":
      return {};
    case "object": {
      const obj: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(spec.shape ?? {})) {
        if (!child.isOptional) obj[k] = emptyValueFor(child);
      }
      return obj;
    }
    case "enum":
      return spec.enumValues?.[0] ?? "";
    default:
      return undefined;
  }
}

function CollapsibleSection({ title, children, depth }: { title: string; children: ReactNode; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  return (
    <section className="rounded-xl border border-edge bg-raised">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 border-b border-edge px-3.5 py-2 text-left"
      >
        <span className="text-[11px] text-ink-muted">{open ? "▾" : "▸"}</span>
        <h3 className="text-[12.5px] font-semibold text-ink">{title}</h3>
      </button>
      {open && <div className="flex flex-col gap-2.5 px-3.5 py-2.5">{children}</div>}
    </section>
  );
}

export function SchemaField({ spec, value, path, onChange }: SchemaFieldProps) {
  const normalized = normalizePath(path);
  const override = FIELD_OVERRIDES[normalized];
  if (override) return override({ spec, value, path, onChange });

  const key = path.length > 0 ? String(path[path.length - 1]) : "";
  const label = labelFor(normalized, spec.key || key);

  switch (spec.kind) {
    case "literal":
      return (
        <Field label={label}>
          <div className="px-1 py-1.5 font-mono text-[12.5px] text-ink-dim">{String(value ?? spec.enumValues?.[0] ?? "")}</div>
        </Field>
      );

    case "string": {
      const str = typeof value === "string" ? value : "";
      const long = str.length > 80 || str.includes("\n");
      return (
        <Field label={label}>
          {long ? (
            <Textarea rows={3} value={str} onChange={(e) => onChange(path, e.target.value)} />
          ) : (
            <Input value={str} onChange={(e) => onChange(path, e.target.value)} />
          )}
        </Field>
      );
    }

    case "number": {
      const num = typeof value === "number" ? value : 0;
      return (
        <Field label={label}>
          <Input
            type="number"
            value={Number.isFinite(num) ? num : 0}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange(path, Number.isFinite(n) ? n : 0);
            }}
          />
        </Field>
      );
    }

    case "boolean":
      return <Checkbox label={label} checked={Boolean(value)} onChange={(e) => onChange(path, e.target.checked)} />;

    case "enum": {
      // `null` özel bir sentinel ile temsil edilir: gerçek enum değerleriyle
      // ÇAKIŞMAYAN bir string (`__null__`), Select value'su her zaman string
      // olmak zorunda olduğu için. Seçilince gerçek `null`a çevrilir — ilk
      // enum seçeneğine SESSİZCE düşmek yerine (eskiden `value` null/undefined
      // olduğunda buraya düşerdi, "onay gerekmiyor" "cheap" olurdu — CodeRabbit).
      const NULL_SENTINEL = "__null__";
      const options = spec.enumValues ?? [];
      const current = value === null ? NULL_SENTINEL : typeof value === "string" ? value : options[0];
      return (
        <Field label={label}>
          <Select
            value={current}
            onChange={(e) => onChange(path, e.target.value === NULL_SENTINEL ? null : e.target.value)}
          >
            {spec.isNullable && <option value={NULL_SENTINEL}>— tanımsız (null) —</option>}
            {options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </Select>
        </Field>
      );
    }

    case "object": {
      const obj = (value ?? {}) as Record<string, unknown>;
      if (spec.isOptional && value === undefined) {
        return (
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-ink-dim">{label}: tanımsız</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(path, emptyValueFor(spec))}>
              tanımla
            </Button>
          </div>
        );
      }
      return (
        <CollapsibleSection title={label} depth={path.length}>
          {Object.entries(spec.shape ?? {}).map(([k, child]) => (
            <SchemaField key={k} spec={child} value={obj[k]} path={[...path, k]} onChange={onChange} />
          ))}
          {spec.isOptional && (
            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => onChange(path, undefined)}>
              kaldır
            </Button>
          )}
        </CollapsibleSection>
      );
    }

    case "array": {
      const arr = Array.isArray(value) ? value : [];
      const element = spec.element!;
      return (
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[11px] tracking-[.06em] uppercase text-ink-muted">{label}</span>
          {arr.length === 0 && <div className="text-[12px] text-ink-dim">boş liste</div>}
          {arr.map((_, i) => (
            <div key={i} className="flex items-start gap-2 rounded-lg border border-edge-control p-2">
              <div className="min-w-0 flex-1">
                <SchemaField spec={element} value={arr[i]} path={[...path, i]} onChange={onChange} />
              </div>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => onChange(path, removeAtPath(arr, [i]))}
              >
                sil
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => onChange(path, [...arr, emptyValueFor(element)])}
          >
            + ekle
          </Button>
        </div>
      );
    }

    case "record": {
      const element = spec.element!;
      const record = (value ?? {}) as Record<string, unknown>;

      // string value → EnvTable (en yaygın durum, 5+ tekrar tek widget'ta).
      if (element.kind === "string") {
        return (
          <Field label={label}>
            <EnvTable value={record as Record<string, string>} onChange={(next) => onChange(path, next)} />
          </Field>
        );
      }

      // Sabit anahtarlı (partialRecord — ör. triage.ladder) normalde overrides'a
      // yönlenir; buraya düşerse (override tanımlanmamışsa) yine de anahtarları
      // sabit tutup değer ekleme/çıkarmayı kapatan bir tablo göster.
      const keys = spec.recordKeyEnum ?? Object.keys(record);

      function addKey() {
        let i = 1;
        let k = "yeni_anahtar";
        while (k in record) k = `yeni_anahtar_${i++}`;
        onChange(path, { ...record, [k]: emptyValueFor(element) });
      }

      function renameKey(oldKey: string, newKey: string) {
        if (oldKey === newKey || newKey in record) return;
        const next: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(record)) next[k === oldKey ? newKey : k] = v;
        onChange(path, next);
      }

      return (
        <CollapsibleSection title={label} depth={path.length}>
          {keys.map((k) => (
            <div key={k} className="rounded-lg border border-edge-control p-2">
              <div className="mb-1.5 flex items-center gap-2">
                {spec.recordKeyEnum ? (
                  <span className="font-mono text-[12px] text-ink-body">{k}</span>
                ) : (
                  <Input className="flex-1 font-mono text-[12px]" value={k} onChange={(e) => renameKey(k, e.target.value)} />
                )}
                {!spec.recordKeyEnum && (
                  <Button type="button" variant="danger" size="sm" onClick={() => onChange(path, removeAtPath(record, [k]))}>
                    sil
                  </Button>
                )}
              </div>
              <SchemaField spec={element} value={record[k]} path={[...path, k]} onChange={onChange} />
            </div>
          ))}
          {!spec.recordKeyEnum && (
            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={addKey}>
              + anahtar ekle
            </Button>
          )}
        </CollapsibleSection>
      );
    }

    default:
      return null;
  }
}

// Kök bileşenin de kullanabilmesi için re-export.
export { getAtPath, setAtPath };
