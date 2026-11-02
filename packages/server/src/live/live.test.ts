import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { parse } from "yaml";

import { LiveSchema, ServiceSchema, type Live } from "@ahtapot/shared";

import { renderComposeOverride } from "./compose.js";
import { waitForReady } from "./readiness.js";

/** Northwind'e benzer canlı tanım: host + postgres (zorunlu) + elasticsearch (isteğe bağlı). */
function northwindLive(extra: Partial<Live> = {}): Live {
  return LiveSchema.parse({
    compose: { base: "deploy/docker-compose.yml" },
    app: { service: "host", containerPort: 5080 },
    services: ["postgres", "elastic"],
    emptyEnv: ["Northwind__Elastic__Url", "Northwind__Rabbit__Host"],
    healthcheck: { path: "/api/ping", expectStatus: [200], timeoutMinutes: 1, intervalSeconds: 1 },
    readiness: { logPattern: "Registered (\\d+) endpoints", minCaptureValue: 0, failPatterns: ["Unhandled exception"] },
    ...extra,
  });
}

/** `services` kataloğundan çözülmüş hâli — `renderComposeOverride` bunu alır. */
const northwindDeps = [
  ServiceSchema.parse({ name: "postgres", image: "postgres:15", internalPort: 5432, healthCmd: "pg_isready -U postgres" }),
  ServiceSchema.parse({ name: "elastic", image: "elasticsearch:9", internalPort: 9200, optional: true }),
];

interface ComposeDoc {
  name: string;
  services: Record<string, Record<string, unknown>>;
  networks: Record<string, { internal: boolean }>;
  volumes?: Record<string, { external: boolean }>;
}

test("compose: portlar havuzdan, ağ internal, emptyEnv tek boşluk, zorunlu bağımlılık sağlık bekler", () => {
  const out = renderComposeOverride({
    jobId: "j1", live: northwindLive(), dependencies: northwindDeps, hostPorts: [20007],
    appEnv: { ASPNETCORE_ENVIRONMENT: "Development" },
    extraEnv: { DataSettings__DataConnectionString: "Host=postgres;Password=x" },
    volumes: { postgres: { volume: "ahtapot-db-j1", mountPath: "/var/lib/postgresql/data" } },
  });
  const doc = parse(out.yaml) as ComposeDoc;
  const host = doc.services["host"]!;

  assert.equal(out.appUrl, "http://127.0.0.1:20007");
  assert.deepEqual(host["ports"], ["127.0.0.1:20007:5080"]);
  const env = host["environment"] as Record<string, string>;
  assert.equal(env["Northwind__Elastic__Url"], " ", "boş dize değil TEK BOŞLUK olmalı");
  assert.equal(env["DataSettings__DataConnectionString"], "Host=postgres;Password=x");
  assert.equal(env["ASPNETCORE_ENVIRONMENT"], "Development");
  assert.deepEqual(host["depends_on"], {
    postgres: { condition: "service_healthy" },
    elastic: { condition: "service_started" },
  });

  assert.equal(doc.networks["ahtapot-net-j1"]?.internal, true, "egress kapalı olmalı");
  // Ölçüldü: internal ağda yayınlanan port host'tan erişilemez; app edge'e de bağlanır, bağımlılık bağlanmaz.
  assert.deepEqual(host["networks"], ["ahtapot-net-j1", "ahtapot-net-j1-edge"]);
  const pg = doc.services["postgres"]!;
  assert.deepEqual(pg["networks"], ["ahtapot-net-j1"]);
  assert.deepEqual(pg["volumes"], ["ahtapot-db-j1:/var/lib/postgresql/data"]);
  assert.equal(doc.volumes?.["ahtapot-db-j1"]?.external, true);
  assert.equal(doc.name, "ahtapot-j1");
});

test("compose: allowEgress açıksa ağ internal değil; port yoksa hata", () => {
  const out = renderComposeOverride({ jobId: "j2", live: northwindLive({ allowEgress: true }), hostPorts: [20010] });
  const doc = parse(out.yaml) as ComposeDoc;
  assert.equal(doc.networks["ahtapot-net-j2"]?.internal, false);
  assert.throws(() => renderComposeOverride({ jobId: "j3", live: northwindLive(), hostPorts: [] }), /host portu/);
});

/** Hazır imaj yolu: worktree mount edilir, komut orada koşar. */
function imageLive(extra: Record<string, unknown> = {}): Live {
  return LiveSchema.parse({
    app: {
      service: "host", containerPort: 5080,
      image: "northwind-dev:latest", workdir: "/workspace",
      command: "dotnet run",
    },
    healthcheck: { path: "/api/ping", expectStatus: [200] },
    ...extra,
  });
}

test("compose: build zinciri verilince command onu taşır, entrypoint sh -lc kalır", () => {
  const chain = "echo '::ahtapot:step:dotnet'; ( cd '/workspace/w' && dotnet build ) || exit 1\ncd '/workspace/w' && dotnet run";
  const out = renderComposeOverride({
    jobId: "j4", live: imageLive(), hostPorts: [20020], buildChain: chain,
  });
  const host = (parse(out.yaml) as ComposeDoc).services["host"]!;

  assert.deepEqual(host["entrypoint"], ["sh", "-lc"]);
  assert.deepEqual(host["command"], [chain], "zincir tek eleman olarak geçmeli");
  // Başlatma komutu zincirin İÇİNDE; ayrıca yazılmamalı.
  assert.equal((host["command"] as string[]).length, 1);
});

test("compose: startCommand app.command yokken başlatma komutu olur (ölü alan değil)", () => {
  const live = LiveSchema.parse({
    startCommand: { name: "host", run: "dotnet run --project Northwind.Host" },
    app: { service: "host", containerPort: 5080, image: "northwind-dev:latest", workdir: "/workspace" },
    healthcheck: { path: "/api/ping", expectStatus: [200] },
  });
  const out = renderComposeOverride({ jobId: "j5", live, hostPorts: [20030] });
  const host = (parse(out.yaml) as ComposeDoc).services["host"]!;

  assert.deepEqual(host["command"], ["dotnet run --project Northwind.Host"]);
  assert.deepEqual(host["entrypoint"], ["sh", "-lc"]);
});

test("compose: yer tutucular zincirin TAMAMINA uygulanır, yalnız başlatmaya değil", () => {
  const out = renderComposeOverride({
    jobId: "j6", live: imageLive(), hostPorts: [20040],
    buildChain: "npm ci --prefix cache-$jobIdShort && dotnet run",
  });
  const host = (parse(out.yaml) as ComposeDoc).services["host"]!;
  const cmd = (host["command"] as string[])[0]!;
  assert.doesNotMatch(cmd, /\$jobIdShort/, "build kısmındaki yer tutucu da çözülmeli");
});

/** Gerçek HTTP sunucusu; durum kodu ve log dışarıdan değiştirilir. */
function fakeApp() {
  let status = 503;
  let log = "";
  const srv = createServer((_req, res) => { res.statusCode = status; res.end("x"); });
  return {
    async start() { await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r())); return `http://127.0.0.1:${(srv.address() as { port: number }).port}`; },
    setStatus(s: number) { status = s; },
    appendLog(l: string) { log += l + "\n"; },
    readLog: async () => log,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

test("hazırlık: HTTP 200 ama log'da uç kaydı yoksa HAZIR DEĞİL (Northwind dersi)", async () => {
  const app = fakeApp();
  const url = await app.start();
  try {
    app.setStatus(200);
    const live = northwindLive();
    const r = await waitForReady({ url, healthcheck: live.healthcheck, readiness: live.readiness, readLog: app.readLog, intervalMs: 50, timeoutMs: 400 });
    assert.equal(r.ready, false);
    assert.match(r.reason, /log deseni yok/);

    // Sıfır uç de hazır değil: yakalanan değer minCaptureValue'yu aşmalı.
    app.appendLog("Registered 0 endpoints");
    const r0 = await waitForReady({ url, healthcheck: live.healthcheck, readiness: live.readiness, readLog: app.readLog, intervalMs: 50, timeoutMs: 400 });
    assert.equal(r0.ready, false);
    assert.equal(r0.captured, 0);

    app.appendLog("Registered 143 endpoints");
    const ok = await waitForReady({ url, healthcheck: live.healthcheck, readiness: live.readiness, readLog: app.readLog, intervalMs: 50, timeoutMs: 2000 });
    assert.equal(ok.ready, true);
    assert.equal(ok.captured, 143);
  } finally {
    await app.close();
  }
});

test("hazırlık: log'da uç var ama HTTP 503 → bekler, sonra 200 gelince hazır; başarısızlık deseni hemen keser", async () => {
  const app = fakeApp();
  const url = await app.start();
  try {
    const live = northwindLive();
    app.appendLog("Registered 12 endpoints");
    setTimeout(() => app.setStatus(200), 200);
    const ok = await waitForReady({ url, healthcheck: live.healthcheck, readiness: live.readiness, readLog: app.readLog, intervalMs: 50, timeoutMs: 3000 });
    assert.equal(ok.ready, true);
    assert.ok(ok.elapsedMs >= 150, "503 iken hazır sayıldı");

    app.appendLog("Unhandled exception. Elasticsearch unreachable");
    const dead = await waitForReady({ url, healthcheck: live.healthcheck, readiness: live.readiness, readLog: app.readLog, intervalMs: 50, timeoutMs: 3000 });
    assert.equal(dead.ready, false);
    assert.match(dead.reason, /başarısızlık deseni/);
    assert.ok(dead.elapsedMs < 500, "başarısızlık deseni zaman aşımını beklememeli");
  } finally {
    await app.close();
  }
});

test("hazırlık: readiness tanımsızsa yalnız HTTP yeter; sunucu yoksa zaman aşımı", async () => {
  const app = fakeApp();
  const url = await app.start();
  try {
    app.setStatus(200);
    const live = northwindLive();
    const ok = await waitForReady({ url, healthcheck: live.healthcheck, readiness: undefined, readLog: async () => "", intervalMs: 50, timeoutMs: 1000 });
    assert.equal(ok.ready, true);
  } finally {
    await app.close();
  }
  const live = northwindLive();
  const gone = await waitForReady({ url: "http://127.0.0.1:1", healthcheck: live.healthcheck, readiness: undefined, readLog: async () => "", intervalMs: 50, timeoutMs: 300 });
  assert.equal(gone.ready, false);
  assert.match(gone.reason, /zaman aşımı/);
});
