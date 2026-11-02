import { test } from "node:test";
import assert from "node:assert/strict";

import { BuildSchema, type ProjectProfile } from "@ahtapot/shared";

import { FAIL_SENTINEL, STEP_SENTINEL, parseFailedStep, renderBuildChain } from "./buildChain.js";

/** Northwind sırası: npm modüller → npm kabuk → dotnet. Sıra bağlayıcı. */
function northwindBuild(extra: Partial<ProjectProfile["build"]> = {}): ProjectProfile["build"] {
  return BuildSchema.parse({
    preSteps: [{ name: "appsettings", run: "cp appsettings.json.example appsettings.json" }],
    steps: [
      { name: "npm modüller", run: "npm ci", cwd: "Northwind.Web" },
      { name: "dotnet", run: "dotnet build", whenChanged: ["**/*.cs"] },
    ],
    ...extra,
  });
}

test("zincir: preSteps + steps sırayla, whenChanged yok sayılır, start sona gelir", () => {
  const chain = renderBuildChain(northwindBuild(), "dotnet run --project Northwind.Host", "/workspace/w/Northwind");

  const order = [
    chain.indexOf("appsettings"),
    chain.indexOf("npm ci"),
    chain.indexOf("dotnet build"),
    chain.indexOf("dotnet run --project Northwind.Host"),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order, "profil sırası korunmalı; ters sıra sessizce bozuk çıktı verir");
  assert.ok(order.every((i) => i >= 0));

  // `whenChanged` taşıyan adım KOŞULSUZ girer: canlı ortam tam build ister,
  // atlanmış katmanın çıktısı volume'de hiç olmayabilir.
  assert.match(chain, /dotnet build/);

  // `cwd` birleştirmesi `gate.ts` ile aynı kural.
  assert.match(chain, /cd '\/workspace\/w\/Northwind\/Northwind\.Web' && npm ci/);
  assert.match(chain, /cd '\/workspace\/w\/Northwind' && dotnet build/);
});

test("zincir: zorunlu adım exit 1 üretir, optional adım zinciri durdurmaz", () => {
  const build = northwindBuild({
    steps: [
      BuildSchema.parse({ steps: [{ name: "zorunlu", run: "make" }] }).steps[0]!,
      BuildSchema.parse({ steps: [{ name: "gevşek", run: "lint", optional: true }] }).steps[0]!,
    ],
  });
  const chain = renderBuildChain(build, "start", "/w");

  assert.match(chain, new RegExp(`${FAIL_SENTINEL}zorunlu.*exit 1`, "s"));
  assert.match(chain, /\( cd '\/w' && lint \) \|\| true/, "optional adım zinciri kırmamalı");
  assert.doesNotMatch(chain, new RegExp(`${FAIL_SENTINEL}gevşek`));
});

test("zincir: tek tırnak ve env değeri kaçar — komut enjeksiyonu olmamalı", () => {
  const build = BuildSchema.parse({
    steps: [{ name: "kötü", run: "echo hi", cwd: "a'b", env: { K: "v'; rm -rf /" } }],
  });
  const chain = renderBuildChain(build, "start", "/w");

  assert.match(chain, /cd '\/w\/a'\\''b'/, "cwd tek tırnağı kaçmalı");
  assert.match(chain, /K='v'\\''; rm -rf \/'/, "env değeri kaçmalı");
});

test("zincir: her adımın önünde işaretçi var, alt kabuk cd sızdırmaz", () => {
  const chain = renderBuildChain(northwindBuild(), "start", "/w");
  for (const name of ["appsettings", "npm modüller", "dotnet"]) {
    assert.ok(chain.includes(`${STEP_SENTINEL}${name}`), `işaretçi eksik: ${name}`);
  }
  // Alt kabuk şart: `cd` bir sonraki adıma sızarsa ikinci adım yanlış dizinde koşar.
  assert.match(chain, /\( cd .* \) \|\|/);
});

test("parseFailedStep: düşen adımı log kuyruğundan okur", () => {
  const log = `host-1  | ${STEP_SENTINEL}dotnet\nhost-1  | error CS1002\nhost-1  | ${FAIL_SENTINEL}dotnet\n`;
  assert.equal(parseFailedStep(log), "dotnet");
  assert.equal(parseFailedStep("düz log, hata yok"), null);
});
