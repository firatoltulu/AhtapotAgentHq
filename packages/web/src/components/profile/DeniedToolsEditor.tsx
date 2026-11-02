import { useState } from "react";

import type { SchemaFieldProps } from "./types";
import { Button, Input } from "../../ui";

/**
 * `security.deniedTools` — `Record<string, string[]>` (araç adı → yasak
 * desen listesi, genelde regex — `deniedBashPatterns`teki gibi). Desenler
 * VİRGÜL İÇEREBİLİR (ör. tekrarlama kalıbı `{2,5}`); eskiden tek satırda
 * virgülle ayrılmış gösterilip `split(",")` ile geri okunuyordu — bu, virgül
 * taşıyan geçerli bir deseni birden fazla parçaya bölüp veriyi bozardı
 * (CodeRabbit). Her desen artık kendi input'unda, kayıpsız.
 */
export function DeniedToolsEditor({ value, path, onChange }: SchemaFieldProps) {
  const record = (value ?? {}) as Record<string, string[]>;
  const [newKey, setNewKey] = useState("");

  function setPatternAt(tool: string, index: number, pattern: string) {
    const patterns = [...(record[tool] ?? [])];
    patterns[index] = pattern;
    onChange(path, { ...record, [tool]: patterns });
  }

  function addPattern(tool: string) {
    onChange(path, { ...record, [tool]: [...(record[tool] ?? []), ""] });
  }

  function removePattern(tool: string, index: number) {
    const patterns = (record[tool] ?? []).filter((_, i) => i !== index);
    onChange(path, { ...record, [tool]: patterns });
  }

  function removeTool(tool: string) {
    const next = { ...record };
    delete next[tool];
    onChange(path, next);
  }

  function addTool() {
    const key = newKey.trim();
    if (!key || key in record) return;
    onChange(path, { ...record, [key]: [] });
    setNewKey("");
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[11px] tracking-[.06em] uppercase text-ink-muted">Yasak araçlar</span>
      {Object.keys(record).length === 0 && <div className="text-[12px] text-ink-dim">yasak araç yok</div>}
      {Object.entries(record).map(([tool, patterns]) => (
        <div key={tool} className="rounded-lg border border-edge-control p-2">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-mono text-[12.5px] font-semibold text-ink">{tool}</span>
            <span className="flex-1" />
            <Button type="button" variant="danger" size="sm" onClick={() => removeTool(tool)}>
              aracı sil
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            {patterns.length === 0 && <div className="text-[12px] text-ink-dim">desen yok</div>}
            {patterns.map((pattern, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  className="flex-1 font-mono text-[12px]"
                  value={pattern}
                  onChange={(e) => setPatternAt(tool, i, e.target.value)}
                  placeholder="regex deseni"
                />
                <Button type="button" variant="danger" size="sm" onClick={() => removePattern(tool, i)}>
                  sil
                </Button>
              </div>
            ))}
            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => addPattern(tool)}>
              + desen ekle
            </Button>
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input className="max-w-[220px]" placeholder="araç adı" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
        <Button type="button" variant="ghost" size="sm" onClick={addTool}>
          + araç ekle
        </Button>
      </div>
    </div>
  );
}
