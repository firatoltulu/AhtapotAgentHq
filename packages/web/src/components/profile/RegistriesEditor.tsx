import type { SchemaFieldProps } from "./types";
import { removeAtPath } from "../../profilePath";
import { Button, Field, Input, Select } from "../../ui";

/**
 * `exec.registries[]` — özel npm registry'si ve NuGet feed'i.
 *
 * Genel `array` render'ı türe göre değişen alanları bilmez: npm `scope`+`url`
 * ister, NuGet `source`+`username`. Hepsini birden gösterip yarısını boş
 * bırakmak "hangisini dolduracağım" sorusu doğuruyordu.
 *
 * TOKEN BURADA GİRİLMEZ — yalnız sunucudaki ortam değişkeninin ADI. Profil
 * saklanıyor ve gösteriliyor; değer sunucunun ortamından verilir.
 */

interface PackageSource {
  kind: "npm" | "nuget";
  scope?: string;
  url?: string;
  source?: string;
  username: string;
  tokenEnv: string;
}

/** `exactOptionalPropertyTypes`: boşaltılan alan `undefined` yazılmaz, anahtar düşer. */
function withField(s: PackageSource, key: "scope" | "url" | "source", v: string): PackageSource {
  const { [key]: _drop, ...rest } = s;
  void _drop;
  return v === "" ? rest : { ...rest, [key]: v };
}

export function RegistriesEditor({ value, path, onChange }: SchemaFieldProps) {
  const items = (Array.isArray(value) ? value : []) as PackageSource[];

  const setAt = (i: number, next: PackageSource) => onChange(path, items.map((it, idx) => (idx === i ? next : it)));

  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[11px] tracking-[.06em] uppercase text-ink-muted">Özel paket kaynakları</span>
      {items.length === 0 && <div className="text-[12px] text-ink-dim">özel kaynak yok</div>}
      {items.map((it, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-edge-control p-2">
          <div className="flex items-end gap-2">
            <Field label="Tür">
              <Select
                value={it.kind}
                onChange={(e) => {
                  const kind = e.target.value === "nuget" ? "nuget" : "npm";
                  // Türe ait olmayan alanlar taşınmaz: yarım kalmış `url` NuGet'te anlamsız.
                  setAt(i, { kind, username: it.username, tokenEnv: it.tokenEnv });
                }}
              >
                <option value="npm">npm</option>
                <option value="nuget">NuGet</option>
              </Select>
            </Field>
            <Field label="Token ortam değişkeni (sunucuda)">
              <Input
                value={it.tokenEnv}
                placeholder="NPM_TOKEN_SIRKET"
                onChange={(e) => setAt(i, { ...it, tokenEnv: e.target.value.toUpperCase() })}
              />
            </Field>
            <Button type="button" variant="danger" size="sm" onClick={() => onChange(path, removeAtPath(items, [i]))}>
              sil
            </Button>
          </div>
          {it.kind === "nuget" ? (
            <div className="flex gap-2">
              <Field label="nuget.config kaynak adı">
                <Input
                  value={it.source ?? ""}
                  placeholder="SirketFeed"
                  onChange={(e) => setAt(i, withField(it, "source", e.target.value))}
                />
              </Field>
              <Field label="Kullanıcı adı">
                <Input value={it.username} onChange={(e) => setAt(i, { ...it, username: e.target.value })} />
              </Field>
            </div>
          ) : (
            <div className="flex gap-2">
              <Field label="Scope (boşsa varsayılan registry)">
                <Input
                  value={it.scope ?? ""}
                  placeholder="@sirketim"
                  onChange={(e) => setAt(i, withField(it, "scope", e.target.value))}
                />
              </Field>
              <Field label="Registry adresi">
                <Input
                  value={it.url ?? ""}
                  placeholder="https://npm.pkg.github.com/"
                  onChange={(e) => setAt(i, withField(it, "url", e.target.value))}
                />
              </Field>
            </div>
          )}
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => onChange(path, [...items, { kind: "npm", username: "token", tokenEnv: "" }])}
      >
        + kaynak ekle
      </Button>
    </div>
  );
}
