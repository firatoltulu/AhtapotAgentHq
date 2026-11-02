import type { SchemaFieldProps } from "./types";
import { removeAtPath } from "../../profilePath";
import { Button, Checkbox, Field, Input } from "../../ui";
import { EnvTable } from "./EnvTable";

/**
 * Üst düzey `services[]` için kart görünümü — genel `array`+`object` render'ı
 * yerine, çünkü bu alanlar (imaj, port, env, dış host) TEK BAKIŞTA anlamlı
 * olmalı. Canlı ortam (`live.services`) ve test takımları
 * (`test.suites[].services`) bu kartlardaki ADA başvurur. Asıl tetikleyici senaryo: "postgres:15.5" → "postgres:16" gibi
 * imaj tag'ini hızla değiştirebilmek — `image` burada vurgulu, ayrı bir satır.
 */

interface Dependency {
  name: string;
  image: string;
  internalPort: number;
  env: Record<string, string>;
  healthCmd?: string | undefined;
  optional: boolean;
  dataPath?: string | undefined;
  externalHost?: string | undefined;
  externalPort?: number | undefined;
}

export function DependencyList({ value, path, onChange }: SchemaFieldProps) {
  const deps = (Array.isArray(value) ? value : []) as Dependency[];

  function update(i: number, patch: Partial<Dependency>) {
    const next = deps.map((d, idx) => (idx === i ? { ...d, ...patch } : d));
    onChange(path, next);
  }

  function add() {
    const fresh: Dependency = {
      name: "",
      image: "",
      internalPort: 0,
      env: {},
      optional: false,
    };
    onChange(path, [...deps, fresh]);
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[11px] tracking-[.06em] uppercase text-ink-muted">Servisler</span>
      {deps.length === 0 && <div className="text-[12px] text-ink-dim">servis yok</div>}
      {deps.map((d, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-edge-control p-3">
          <div className="flex items-start gap-2">
            <div className="grid flex-1 grid-cols-2 gap-2">
              <Field label="Servis adı">
                <Input value={d.name} onChange={(e) => update(i, { name: e.target.value })} />
              </Field>
              <Field label="İmaj (ör. postgres:16)">
                <Input
                  className="font-mono"
                  value={d.image}
                  onChange={(e) => update(i, { image: e.target.value })}
                  placeholder="repo/imaj:tag"
                />
              </Field>
              <Field label="İç port">
                <Input
                  type="number"
                  value={d.internalPort}
                  onChange={(e) => update(i, { internalPort: Number(e.target.value) || 0 })}
                />
              </Field>
              <Field label="Sağlık kontrolü komutu">
                <Input value={d.healthCmd ?? ""} onChange={(e) => update(i, { healthCmd: e.target.value || undefined })} />
              </Field>
              <Field label="Dış host">
                <Input value={d.externalHost ?? ""} onChange={(e) => update(i, { externalHost: e.target.value || undefined })} />
              </Field>
              <Field label="Dış port">
                <Input
                  type="number"
                  value={d.externalPort ?? ""}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    update(i, { externalPort: e.target.value === "" ? undefined : Number.isFinite(n) ? n : undefined });
                  }}
                />
              </Field>
              <Field label="Veri yolu">
                <Input value={d.dataPath ?? ""} onChange={(e) => update(i, { dataPath: e.target.value || undefined })} />
              </Field>
            </div>
            <Button type="button" variant="danger" size="sm" onClick={() => onChange(path, removeAtPath(deps, [i]))}>
              sil
            </Button>
          </div>
          <Checkbox
            label="İsteğe bağlı (yoksa canlı uygulama yine kalkar)"
            checked={d.optional}
            onChange={(e) => update(i, { optional: e.target.checked })}
          />
          <Field label="Ortam değişkenleri">
            <EnvTable value={d.env ?? {}} onChange={(env) => update(i, { env })} />
          </Field>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={add}>
        + servis ekle
      </Button>
    </div>
  );
}
