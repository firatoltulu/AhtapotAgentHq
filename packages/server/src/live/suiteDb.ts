import type Dockerode from "dockerode";

import type { SuiteDatabases } from "../build/tests.js";
import { dbDependency } from "./golden.js";
import { dbNamesFor, pgConnString, pgCredsFrom, startPsqlHelper, suiteDbName, type TemplateDb } from "./templateDb.js";

/**
 * Test takımlarına şablondan taze DB klonu (`test.suites[].cloneDb`).
 *
 * Canlı ortamın klonuyla AYNI şablon ve aynı kimlik (`database.clone`), ama
 * ayrı ad ve ayrı ömür: koşu başına açılır, koşu bitince düşer. Canlı klonu
 * kullanmak yanlıştı — insan onun içinde elle test ediyor ve baseline ile
 * gerçek koşu aynı veriyi kirletirdi.
 *
 * Şablonu KURMAZ. Kurulum migrate + seed için uygulamanın tamamını (Redis,
 * Elasticsearch) istiyor ve bu yalnız canlı ortamın compose ağında mümkün.
 * Şablon yoksa açık bir hatayla döner.
 *
 * Bugün yalnız DIŞ Postgres: konteynerdeki Postgres yalnız canlı ortam
 * ayaktayken var ve test koşusu ona bağlanamaz.
 */
export class TemplateSuiteDatabases implements SuiteDatabases {
  constructor(private readonly deps: { docker: Dockerode; templates: TemplateDb }) {}

  async open(input: Parameters<SuiteDatabases["open"]>[0]): ReturnType<SuiteDatabases["open"]> {
    const { profile } = input;
    if (profile.database.kind !== "postgres") {
      throw new Error(`DB klonlaması yalnız postgres için; database.kind = ${profile.database.kind}`);
    }
    const dep = dbDependency(profile);
    const creds = pgCredsFrom(profile);
    if (!dep || !creds) throw new Error(`database.clone.service (${profile.database.clone.service}) services içinde yok`);
    if (!dep.externalHost) {
      throw new Error(`klon servisi ${dep.name} konteynerde; test klonu yalnız dış Postgres'te (externalHost) destekleniyor`);
    }

    const { templates, docker } = this.deps;
    const { template } = dbNamesFor(profile, input.jobId);
    const target = suiteDbName(profile, input.jobId, input.suiteId, input.kind);
    const cid = await startPsqlHelper(docker, profile);
    const remove = () => docker.getContainer(cid).remove({ force: true }).catch(() => {});
    try {
      const ready = await templates.ready(cid, creds);
      if (!ready.ok) throw new Error(`postgres cevap vermedi (${dep.externalHost}:${dep.externalPort ?? dep.internalPort}): ${ready.reason}`);
      if (!(await templates.templateExists(cid, template, creds))) {
        throw new Error(`şablon DB yok (${template}) — şablon canlı ortam ilk kalktığında kurulur; önce bir canlı ortam açın`);
      }
      await templates.cloneFromTemplate(cid, template, target, creds);
    } catch (err) {
      await remove();
      throw err;
    }
    input.log(`■ ${input.suiteId}: test DB'si şablondan klonlandı: ${target}`);
    return {
      connectionString: pgConnString(dep, target, creds),
      close: async () => {
        try {
          if (!(await templates.dropJobDb(cid, target, creds))) throw new Error(target);
          input.log(`■ ${input.suiteId}: test DB'si düşürüldü: ${target}`);
        } finally {
          await remove();
        }
      },
    };
  }
}
