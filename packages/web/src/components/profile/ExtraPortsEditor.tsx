import type { SchemaFieldProps } from "./types";
import { removeAtPath } from "../../profilePath";
import { Button, Checkbox, Field, Input } from "../../ui";

/**
 * `live.app.extraPorts[]` — `primary` alanı RADIO davranışlı: yalnız bir
 * satır birincil olabilir (canlı test kartındaki bağlantı ona gider). Genel
 * `array`+`boolean` render'ı bu tekillik kuralını bilmez, checkbox'ı bağımsız
 * işaretlerdi — burada bir satır seçilince diğerleri otomatik false'a çekilir.
 */

interface ExtraPort {
  containerPort: number;
  label: string;
  primary: boolean;
}

export function ExtraPortsEditor({ value, path, onChange }: SchemaFieldProps) {
  const ports = (Array.isArray(value) ? value : []) as ExtraPort[];

  function update(i: number, patch: Partial<ExtraPort>) {
    onChange(path, ports.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }

  function setPrimary(i: number) {
    onChange(path, ports.map((p, idx) => ({ ...p, primary: idx === i })));
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[11px] tracking-[.06em] uppercase text-ink-muted">Ek portlar</span>
      {ports.length === 0 && <div className="text-[12px] text-ink-dim">ek port yok</div>}
      {ports.map((p, i) => (
        <div key={i} className="flex items-end gap-2 rounded-lg border border-edge-control p-2">
          <Field label="Port">
            <Input
              type="number"
              value={p.containerPort}
              onChange={(e) => update(i, { containerPort: Number(e.target.value) || 0 })}
            />
          </Field>
          <Field label="Etiket">
            <Input value={p.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="UI, API…" />
          </Field>
          <Checkbox label="Birincil" checked={p.primary} onChange={() => setPrimary(i)} />
          <Button type="button" variant="danger" size="sm" onClick={() => onChange(path, removeAtPath(ports, [i]))}>
            sil
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => onChange(path, [...ports, { containerPort: 0, label: "", primary: ports.length === 0 }])}
      >
        + port ekle
      </Button>
    </div>
  );
}
