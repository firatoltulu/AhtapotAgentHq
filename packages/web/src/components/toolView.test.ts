import { test } from "node:test";
import assert from "node:assert/strict";

import type { ServerEvent } from "@ahtapot/shared";

import { commandLabel, exitHint, fileFromSummary, splitPath, toolView } from "./toolView.ts";

/**
 * Akış satırının türetilmesi.
 *
 * Kabul kriteri 1 burada korunur: hiçbir satırda ham argüman JSON'u
 * görünmemeli. Bir gerileme (yeni araç adı, eksik alan) bunu sessizce geri
 * getirebilir — satır yine çizilir, yalnız içi okunmaz hâle gelir.
 */

function toolUse(over: Partial<Extract<ServerEvent, { type: "agent.tool_use" }>>): ServerEvent {
  return {
    type: "agent.tool_use",
    seq: 1,
    jobId: "j",
    at: "2026-09-17T10:00:00.000Z",
    runId: "r",
    toolId: "t",
    name: "Read",
    inputSummary: "",
    meta: [],
    diff: [],
    ...over,
  } as ServerEvent;
}

test("splitPath dizini ayrı, dosyayı ayrı verir", () => {
  assert.deepEqual(splitPath("Northwind/Sales/Test.cs"), { dir: "Northwind/Sales/", file: "Test.cs" });
  assert.deepEqual(splitPath("E:\\p\\a.ts"), { dir: "E:\\p\\", file: "a.ts" });
  assert.deepEqual(splitPath("kök.ts"), { dir: "", file: "kök.ts" });
});

test("Edit satırı fark olarak okunur, ham JSON basmaz", () => {
  const v = toolView(
    toolUse({
      name: "Edit",
      file: "src/App.tsx",
      diff: [["-", "eski"], ["+", "yeni"]],
      meta: ["+1 −1"],
      inputSummary: '{"replace_all":false,"file_path":"src/App.tsx","old_string":"eski',
    }),
  );
  assert.equal(v.tone, "edit");
  assert.equal(v.file, "App.tsx");
  assert.equal(v.dir, "src/");
  assert.equal(v.diff.length, 2);
  // Gövde metni BOŞ: `inputSummary` son çare ve burada yola düşülmüş durumda.
  assert.equal(v.text, "");
});

test("komut satırı komutu taşır, özet metnine düşmez", () => {
  const v = toolView(toolUse({ name: "Bash", command: "npm run build", cwd: "/w", inputSummary: '{"command":"npm' }));
  assert.equal(v.tone, "cmd");
  assert.equal(v.command, "npm run build");
  assert.equal(v.text, "");
});

/**
 * YAŞANDI senaryosunun geriye dönük hâli: `file` alanı eklenmeden yazılmış
 * bir `Edit` replay'de gelirse hiç olmazsa yol görünmeli.
 */
test("eski olayda yol kesilmemiş özetten kurtarılır", () => {
  const v = toolView(
    toolUse({ name: "Edit", inputSummary: '{"file_path":"src/a.ts","old_string":"x","new_string":"y"}' }),
  );
  assert.equal(v.file, "a.ts");
  assert.equal(v.dir, "src/");
});

test("özet kesikse yol uydurulmaz", () => {
  assert.equal(fileFromSummary('{"replace_all":false,"file_path":"E:\\\\Proj'), "");
});

test("yol da komut da yoksa özet tek satıra indirgenir", () => {
  const v = toolView(toolUse({ name: "mcp__db__query", inputSummary: '{"sql":\n  "select 1"}' }));
  // Tek satır: JSON'un satır sonları gövdeyi çok satırlı kutuya çevirmemeli.
  assert.ok(!v.text.includes("\n"));
  assert.ok(v.text.length > 0);
});

test("agent.message rolü aktör olarak görünür", () => {
  const sys = toolView({
    type: "agent.message",
    seq: 2,
    jobId: "j",
    at: "2026-09-17T10:00:00.000Z",
    runId: "r",
    role: "system",
    content: "not",
  });
  // Rol görünmezse sistem notu agent'ın sözü sanılır.
  assert.equal(sys.actor, "sistem");
  const asst = toolView({
    type: "agent.message",
    seq: 3,
    jobId: "j",
    at: "2026-09-17T10:00:00.000Z",
    runId: "r",
    role: "assistant",
    content: "söz",
  });
  assert.equal(asst.actor, "");
});

test("commandLabel çok satırlı komutun ilk anlamlı satırını alır", () => {
  assert.equal(commandLabel("\n\nnpm ci\nnpm run build"), "npm ci");
  assert.ok(commandLabel("x".repeat(200)).endsWith("…"));
});

test("exitHint yalnız kırık komutta konuşur", () => {
  assert.equal(exitHint(0, true), "");
  assert.equal(exitHint(undefined, true), "");
  assert.ok(exitHint(127, false).length > 0);
  assert.ok(exitHint(137, false).includes("öldürüldü"));
  assert.ok(exitHint(1, false).length > 0);
});
