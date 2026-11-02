import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";

import { liveSubdomain } from "@ahtapot/shared";

import { renderTraefikRoute } from "./traefik.js";

test("renderTraefikRoute: subdomain jobId'den deterministik türer", () => {
  const out = renderTraefikRoute({
    jobId: "job-1", domain: "erksoft.net", certResolver: "le",
    backendHost: "127.0.0.1", targetPort: 20001,
  });
  assert.equal(out.subdomain, liveSubdomain("job-1"));
  assert.equal(out.publicUrl, `https://${liveSubdomain("job-1")}.erksoft.net`);
});

test("renderTraefikRoute: YAML tek servis + tek router, backendHost/port doğru", () => {
  const out = renderTraefikRoute({
    jobId: "job-2", domain: "erksoft.net", certResolver: "le",
    backendHost: "host.docker.internal", targetPort: 20042,
  });
  const doc = parse(out.yaml) as {
    http: { services: Record<string, { loadBalancer: { servers: { url: string }[] } }>; routers: Record<string, { rule: string; tls: { certResolver: string } }> };
  };
  const services = Object.values(doc.http.services);
  const routers = Object.values(doc.http.routers);
  assert.equal(services.length, 1);
  assert.equal(routers.length, 1);
  assert.equal(services[0]!.loadBalancer.servers[0]!.url, "http://host.docker.internal:20042");
  assert.match(routers[0]!.rule, /^Host\(`job-[0-9a-f]{8}\.erksoft\.net`\)$/);
  assert.equal(routers[0]!.tls.certResolver, "le");
});
