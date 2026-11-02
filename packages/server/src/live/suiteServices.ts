import type Dockerode from "dockerode";

import { BRAND, DOCKER_LABEL, containerName, resolveEnvPlaceholders, type Service } from "@ahtapot/shared";

import type { SuiteServices } from "../build/tests.js";
import { demux } from "./golden.js";

/** Sağlık komutu olan servisin hazır olması için tavan; Postgres ilk açılışta ~5 sn. */
const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_INTERVAL_MS = 2_000;

/**
 * Test takımına KONTEYNER servisleri — koşu başına ağ, koşu bitince yıkılır.
 *
 * Servisler canlı ortamdakiyle AYNI adla (ağ takma adı) kalkar: `appEnv`deki
 * `Host=postgres` / `redis:6379` canlıda compose ağında, testte bu ağda
 * çözülür — değişkenler iki bağlamda da aynı kalır (kararlar §38). Agent
 * konteyneri koşu süresince ağa bağlanır; komutlar orada koşuyor.
 *
 * Veri kalıcı DEĞİL: `dataPath` bağlanmaz, her koşu boş servisle başlar
 * (CI'daki gibi). Tohum takımın ön adımının işi. Canlı ortamın Postgres
 * volume'ü paylaşılamaz — iki Postgres aynı veri dizinine yazamaz.
 *
 * Baseline ve gerçek koşu AYRI servis alır: biri ötekinin verisini görmesin.
 */
export class DockerSuiteServices implements SuiteServices {
  constructor(private readonly docker: Dockerode) {}

  async up(input: Parameters<SuiteServices["up"]>[0]): ReturnType<SuiteServices["up"]> {
    const { docker } = this;
    const net = `${BRAND.slug}-t-${input.runId}`.slice(0, 63);
    const labels = { [DOCKER_LABEL.job]: input.jobId, [DOCKER_LABEL.role]: "test-service" };
    const agent = docker.getContainer(containerName.agent(input.jobId));
    // Agent konteyneri yoksa (host yürütücü) servis adı hiçbir yerden çözülmez;
    // ağ kurmadan önce söyle.
    await agent.inspect().catch(() => {
      throw new Error(`konteyner servisi için agent konteyneri gerekli (${containerName.agent(input.jobId)} yok)`);
    });

    const started: Dockerode.Container[] = [];
    let network: Dockerode.Network | null = null;
    let connected = false;
    const down = async (): Promise<void> => {
      for (const c of started) await c.remove({ force: true, v: true }).catch(() => {});
      if (network) {
        if (connected) await network.disconnect({ Container: containerName.agent(input.jobId), Force: true }).catch(() => {});
        await network.remove().catch(() => {});
      }
    };

    try {
      // Önceki çöken koşudan kalmış aynı adlı ağ/konteyner yeni koşuyu düşürmesin.
      await this.removeLeftovers(net, input.services);
      network = await docker.createNetwork({ Name: net, Driver: "bridge", Labels: labels });
      for (const svc of input.services) {
        await this.ensureImage(svc.image, input.log);
        const c = await docker.createContainer({
          name: `${net}-${svc.name}`.slice(0, 120),
          Image: svc.image,
          Env: Object.entries(resolveEnvPlaceholders(svc.env, input.jobId)).map(([k, v]) => `${k}=${v}`),
          Labels: labels,
          HostConfig: { NetworkMode: net, RestartPolicy: { Name: "no" } },
          NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: [svc.name] } } },
        });
        started.push(c);
        await c.start();
      }
      await network.connect({ Container: containerName.agent(input.jobId) });
      connected = true;

      for (const [i, svc] of input.services.entries()) {
        if (!svc.healthCmd) continue;
        await this.waitHealthy(started[i]!, svc);
      }
      input.log(`■ test servisleri hazır: ${input.services.map((s) => `${s.name}:${s.internalPort}`).join(", ")} (ağ ${net})`);
      return { down };
    } catch (err) {
      await down();
      throw err;
    }
  }

  private async removeLeftovers(net: string, services: Service[]): Promise<void> {
    for (const svc of services) {
      await this.docker.getContainer(`${net}-${svc.name}`.slice(0, 120)).remove({ force: true, v: true }).catch(() => {});
    }
    const old = this.docker.getNetwork(net);
    const info = await old.inspect().catch(() => null) as { Containers?: Record<string, unknown> } | null;
    if (!info) return;
    for (const id of Object.keys(info.Containers ?? {})) await old.disconnect({ Container: id, Force: true }).catch(() => {});
    await old.remove().catch(() => {});
  }

  private async waitHealthy(c: Dockerode.Container, svc: Service): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let last = "";
    while (Date.now() < deadline) {
      const state = await c.inspect().then((i) => i.State).catch(() => null);
      // Konteyner çıktıysa beklemek boşuna: Postgres parola env'i olmadan
      // açılışta çıkar ve sebep yalnız kendi logunda yazar.
      if (state && !state.Running) {
        const logs = await c.logs({ stdout: true, stderr: true, tail: 15 }).catch(() => Buffer.alloc(0));
        throw new Error(`${svc.name} servisi kapandı (çıkış ${state.ExitCode}):\n${demux(logs as Buffer).trim()}`);
      }
      // Tek denemenin hatası kurulumu düşürmez: konteyner tam o an yeniden
      // başlıyor olabilir. Hata metni son sebep olarak tutulur, tavan bekler.
      try {
        const exec = await c.exec({ Cmd: ["sh", "-c", svc.healthCmd!], AttachStdout: true, AttachStderr: true });
        const stream = await exec.start({ hijack: true, stdin: false });
        const chunks: Buffer[] = [];
        // Akış hiç kapanmazsa bekleyiş deadline'da biter; asılı bir exec
        // `up()`ı sonsuza dek tutmasın.
        let timer: NodeJS.Timeout | undefined;
        await new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            stream.destroy();
            resolve();
          }, Math.max(0, deadline - Date.now()));
          stream.on("data", (b: Buffer) => chunks.push(b));
          stream.on("end", () => resolve());
          stream.on("close", () => resolve());
          stream.on("error", () => resolve());
        });
        clearTimeout(timer);
        const { ExitCode } = await exec.inspect();
        if (ExitCode === 0) return;
        last = demux(Buffer.concat(chunks)).trim();
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
    }
    throw new Error(`${svc.name} ${HEALTH_TIMEOUT_MS / 1000} sn içinde hazır olmadı (${svc.healthCmd}): ${last.slice(-300)}`);
  }

  private async ensureImage(image: string, log: (line: string) => void): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      log(`imaj çekiliyor: ${image}`);
    }
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}
