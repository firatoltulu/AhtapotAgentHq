import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Rol promptları `agents/core/<rol>.md` — proje-agnostik, ezilemez.
 * Proje overlay'i (`projects/<slug>/overlays/<rol>.md`) ayrıca eklenir.
 */
export function loadRolePrompt(role: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/agents/prompts.js → paket kökü → repo kökü → agents/core
  const path = join(here, "..", "..", "..", "..", "agents", "core", `${role}.md`);
  return readFileSync(path, "utf8");
}
