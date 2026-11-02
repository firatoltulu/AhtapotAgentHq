import { BRAND } from "@ahtapot/shared";

import { buildApp } from "./app.js";
import { loadConfig } from "./config/index.js";

const config = loadConfig();
const app = await buildApp(config);

/** Kapanışta soketleri ve veritabanını düzgün bırak. */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.fastify.listen({ host: config.host, port: config.port });
app.fastify.log.info(
  `${BRAND.displayName} hazır — http://${config.host}:${config.port}`,
);
