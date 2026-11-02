import { shellQuote, type CommandExecutor, type ExecRequest, type ExecResult } from "./executor.js";
import type { PackageSource } from "@ahtapot/shared";

/**
 * Özel paket kaynağı kimliği (npm + NuGet) — yürütücü sarmalayıcısı.
 *
 * Profil yalnız `scope → url → tokenEnv` söyler; değer sunucu ortamından
 * okunur ve her komuta ayrı env olarak verilir (kural 5).
 *
 * NEDEN DOSYA + `${VAR}`: `npm_config_//host/:_authToken` gibi env anahtarları
 * npm 6'da (Node 12) anahtarı küçültüp `_`yi `-`ye çevirdiği için çalışmaz.
 * `${VAR}` içeren bir userconfig her sürümde çalışır; dosyada SIR YOK, token
 * yalnız süreç env'inde yaşar.
 *
 * NuGet: `NuGetPackageSourceCredentials_<kaynak>` ortam değişkeni (dotnet
 * restore okur; nuget.config'e parola yazmaya gerek kalmaz). Linux'ta
 * nuget.config'teki parola şifrelenemez, düz metindir — env yolu bu yüzden
 * tercih edildi. Kaynak adı repodaki nuget.config'le birebir eşleşmeli.
 */

const NPMRC_PATH = "/tmp/ahtapot-npmrc";

/** `https://npm.pkg.github.com/x/` → `//npm.pkg.github.com/x/` (nerf-dart). */
function nerfDart(url: string): string {
  const u = new URL(url);
  const path = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
  return `//${u.host}${path}`;
}

export interface RegistryAuth {
  /** Sır içermeyen `.npmrc` gövdesi; npm kaynağı yoksa boş. */
  npmrc: string;
  /** Komuta verilecek env: userconfig yolu + token'lar. */
  env: Record<string, string>;
  /** Log'da maskelenecek token değerleri. */
  secrets: string[];
  /** Tanımsız olduğu için çözülemeyen ortam değişkeni adları. */
  missing: string[];
}

export function buildRegistryAuth(
  registries: readonly PackageSource[],
  source: Readonly<Record<string, string | undefined>>,
): RegistryAuth {
  const lines: string[] = [];
  const env: Record<string, string> = {};
  const secrets: string[] = [];
  const missing: string[] = [];
  let hasNpm = false;
  for (const r of registries) {
    const token = source[r.tokenEnv];
    if (!token) {
      if (!missing.includes(r.tokenEnv)) missing.push(r.tokenEnv);
      continue;
    }
    secrets.push(token);
    if (r.kind === "nuget") {
      // `;` NuGet kimlik değerinde alan ayırıcıdır ve kaçışı yok: token'ı keser,
      // dotnet restore anlaşılmaz bir 401 verir. Değeri hata metnine KOYMAYIZ.
      if (r.username.includes(";") || token.includes(";")) {
        throw new Error(`NuGet ${r.source}: ${r.username.includes(";") ? "kullanıcı adı" : `token (${r.tokenEnv})`} ';' içeremez`);
      }
      env[`NuGetPackageSourceCredentials_${r.source}`] =
        `Username=${r.username};Password=${token};ValidAuthenticationTypes=basic`;
      continue;
    }
    hasNpm = true;
    env[r.tokenEnv] = token;
    const key = r.scope ? `${r.scope}:registry` : "registry";
    // `url` npm'de şema ile zorunlu; superRefine tipe yansımıyor.
    const url = r.url ?? "";
    lines.push(`${key}=${url}`);
    lines.push(`${nerfDart(url)}:_authToken=\${${r.tokenEnv}}`);
  }
  if (hasNpm) env["NPM_CONFIG_USERCONFIG"] = NPMRC_PATH;
  return { npmrc: lines.length > 0 ? lines.join("\n") + "\n" : "", env, secrets, missing };
}

/**
 * Komutun env'ine kimliği ekler, ilk satırda `.npmrc`yi yazar, çıktıdaki token
 * değerlerini maskeler (`scrubSecrets` npm token biçimini tanımaz).
 *
 * Çağıranın env'i kazanır: komut kendi `NPM_CONFIG_USERCONFIG`ini verdiyse
 * ona dokunulmaz.
 */
export class RegistryAuthExecutor implements CommandExecutor {
  private readonly auth: RegistryAuth;
  /** Yalnız npm kaynağı varsa `.npmrc` yazılır; NuGet yalnız env ister. */
  private readonly prelude: string;
  /** Etkin değeri sır olan env anahtarları (npm token'ı, NuGet kimlik değeri). */
  private readonly secretEnvKeys: { key: string; nuget: boolean }[];

  constructor(
    private readonly inner: CommandExecutor,
    registries: readonly PackageSource[],
    source: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.auth = buildRegistryAuth(registries, source);
    this.secretEnvKeys = registries.map((r) =>
      r.kind === "nuget" ? { key: `NuGetPackageSourceCredentials_${r.source}`, nuget: true } : { key: r.tokenEnv, nuget: false },
    );
    this.prelude = this.auth.npmrc ? `printf '%s' ${shellQuote(this.auth.npmrc)} > ${NPMRC_PATH} && ` : "";
  }

  run(req: ExecRequest): Promise<ExecResult> {
    const env = { ...this.auth.env, ...req.env };
    // Komut kendi `NPM_TOKEN_...` ya da `NuGetPackageSourceCredentials_...`
    // değerini verdiyse etkin olan O'dur ve çıktıya o düşebilir; sunucu kaynaklı
    // liste onu bilmez. NuGet'te tüm değerin yanında yalnız PAROLA da maskelenir:
    // çıktıya genelde tek başına parola düşer. Boş dize `replaceAll("", "***")`
    // ile her karakteri bozacağından süzülür.
    const effective = this.secretEnvKeys.flatMap(({ key, nuget }) => {
      const v = env[key] ?? "";
      return nuget ? [v, /(?:^|;)Password=([^;]*)/.exec(v)?.[1] ?? ""] : [v];
    });
    // Uzun olan ÖNCE: sunucu token'ı `pw-`, komutun parolası `pw-ezilen` ise kısa
    // olan önce uygulanınca çıktıda `***ezilen` kalırdı.
    const secrets = [...new Set([...this.auth.secrets, ...effective])].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
    // Sunucuda token tanımsız olsa da komut kendi kimliğini verebilir: o durumda
    // da maskeleme gerekir. Geçiş yalnız ikisi de boşken.
    if (Object.keys(this.auth.env).length === 0 && secrets.length === 0) return this.inner.run(req);
    return this.inner.run({
      ...req,
      // `;` değil `&&`: dosya yazılamazsa komut kimliksiz koşup 401 ile
      // yanıltmasın.
      command: `${this.prelude}${req.command}`,
      env,
      onLine: (stream, line) => req.onLine(stream, secrets.reduce((l, s) => l.replaceAll(s, "***"), line)),
    });
  }
}

/** Kayıt tanımlı değilse yürütücüyü olduğu gibi döner. */
export function withRegistryAuth(
  executor: CommandExecutor,
  registries: readonly PackageSource[],
  source: Readonly<Record<string, string | undefined>> = process.env,
): CommandExecutor {
  return registries.length === 0 ? executor : new RegistryAuthExecutor(executor, registries, source);
}
