import { stringify } from "yaml";

import { liveSubdomain } from "@ahtapot/shared";

/**
 * Traefik dinamik dosya üretici — canlı ortam iş başına bir dosya.
 *
 * Referans: `AdventureWorks.TenantManager/templates/traefik-tenant.yml`
 * (DotLiquid). Burada tenant değil iş (jobId) başına, minimal desen: tek
 * servis + tek router. Motora gömülmez — profildeki `live.traefik` alanı
 * etkinliği ve domaini belirler; bu modül saf render, dosya I/O `environment.ts`de.
 */

export interface TraefikRouteInput {
  jobId: string;
  domain: string;
  certResolver: string;
  /** Traefik'in AhtapotAgent sunucusuna ulaşacağı adres (AHTAPOT_TRAEFIK_BACKEND_HOST). */
  backendHost: string;
  /** Host tarafındaki uygulama portu (`rendered.appUrl`den çözülür). */
  targetPort: number;
}

export interface TraefikRouteOutput {
  subdomain: string;
  publicUrl: string;
  yaml: string;
}

/** İşin dış adı (`job-xxxxxxxx.erksoft.net`); route ve uygulama ortamı aynı adı görmeli. */
export function livePublicHost(jobId: string, domain: string): string {
  return `${liveSubdomain(jobId)}.${domain}`;
}

export function renderTraefikRoute(input: TraefikRouteInput): TraefikRouteOutput {
  const subdomain = liveSubdomain(input.jobId);
  const host = livePublicHost(input.jobId, input.domain);
  const serviceName = `${subdomain}-service`;
  const routerName = `${subdomain}-router`;

  const doc = {
    http: {
      services: {
        [serviceName]: {
          loadBalancer: {
            servers: [{ url: `http://${input.backendHost}:${input.targetPort}` }],
          },
        },
      },
      routers: {
        [routerName]: {
          entryPoints: ["websecure"],
          rule: `Host(\`${host}\`)`,
          service: serviceName,
          tls: { certResolver: input.certResolver },
        },
      },
    },
  };

  return {
    subdomain,
    publicUrl: `https://${host}`,
    yaml: stringify(doc, { lineWidth: 0 }),
  };
}
