import { useState } from "react";

import type { SchemaFieldProps } from "./types";
import { SchemaField } from "../SchemaField";
import { Button, Input } from "../../ui";

/**
 * `agents.roles` — serbest anahtarlı `Record<string, AgentRoleSchema>`. Rol
 * adları (planner/developer/qa/devops...) önceden bilinmiyor, bu yüzden genel
 * `record` render'ından FARKLI olarak burada anahtar ekle/çıkar arayüzü var;
 * her rolün İÇİ (model/effort/maxTurns/...) genel `SchemaField` motoruna
 * bırakılır — `AgentRoleSchema` şeması değişirse form otomatik güncellenir.
 */

// Yeni rol eklerken AgentRoleSchema'nın varsayılanlarıyla başlatır — şemadaki
// `.default(...)` değerleriyle birebir, elle tekrarlanmış (introspection'dan
// otomatik türetmek döngüsel bağımlılık yaratırdı: bu dosya `spec.element`i
// zaten props'tan alıyor, ayrıca import etmeye gerek yok).
const AGENT_ROLE_DEFAULTS = {
  model: "claude-opus-5-5",
  effort: "high" as const,
  maxTurns: 100,
  maxBudgetUsd: 10,
};

export function RolesEditor({ spec, value, path, onChange }: SchemaFieldProps) {
  const roles = (value ?? {}) as Record<string, unknown>;
  const [newKey, setNewKey] = useState("");
  const element = spec.element!;

  function addRole() {
    const key = newKey.trim();
    if (!key || key in roles) return;
    onChange(path, { ...roles, [key]: { ...AGENT_ROLE_DEFAULTS } });
    setNewKey("");
  }

  function removeRole(key: string) {
    const next = { ...roles };
    delete next[key];
    onChange(path, next);
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[11px] tracking-[.06em] uppercase text-ink-muted">Roller</span>
      {Object.keys(roles).length === 0 && <div className="text-[12px] text-ink-dim">rol tanımlı değil</div>}
      {Object.entries(roles).map(([key, roleValue]) => (
        <div key={key} className="rounded-lg border border-edge-control p-2">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-mono text-[12.5px] font-semibold text-ink">{key}</span>
            <span className="flex-1" />
            <Button type="button" variant="danger" size="sm" onClick={() => removeRole(key)}>
              sil
            </Button>
          </div>
          <SchemaField spec={element} value={roleValue} path={[...path, key]} onChange={onChange} />
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input
          className="max-w-[220px]"
          placeholder="ör. planner"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <Button type="button" variant="ghost" size="sm" onClick={addRole}>
          + rol ekle
        </Button>
      </div>
    </div>
  );
}
