import type { ReactElement } from "react";

import type { SchemaFieldProps } from "./types";
import type { PathSegment } from "../../profilePath";
import { DependencyList } from "./DependencyCard";
import { ExtraPortsEditor } from "./ExtraPortsEditor";
import { TriageLadderTable } from "./TriageLadderTable";
import { RolesEditor } from "./RolesEditor";
import { DeniedToolsEditor } from "./DeniedToolsEditor";
import { RegistriesEditor } from "./RegistriesEditor";

/**
 * Path → özel widget yönlendirmesi. `SchemaField` her düğümde önce burayı
 * dener; eşleşme yoksa genel `kind`-bazlı render'a düşer.
 *
 * Path'ler dizi indekslerini İÇERMEZ — `normalizePath` sayısal segmentleri
 * atar, `services.0.image` de `services.image` de aynı
 * anahtara düşer. Bu tablo yalnız "birlikte anlamlı" alan GRUPLARINI (dizinin/
 * record'un kendisini) hedefler, tekil yaprak alanları değil.
 */
export const FIELD_OVERRIDES: Record<string, (props: SchemaFieldProps) => ReactElement> = {
  services: DependencyList,
  "live.app.extraPorts": ExtraPortsEditor,
  "agents.triage.ladder": TriageLadderTable,
  "agents.roles": RolesEditor,
  "security.deniedTools": DeniedToolsEditor,
  "exec.registries": RegistriesEditor,
};

/** Sayısal path segmentlerini atar: `["services",0,"image"]` → `"services.image"`. */
export function normalizePath(path: PathSegment[]): string {
  return path.filter((seg) => typeof seg === "string").join(".");
}
