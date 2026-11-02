import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { ProjectProfileSchema, type ProjectProfile } from "@ahtapot/shared";

import { api, type ProfileFull, type ProfileRow, type ValidationCheck } from "../api";
import { labelFor } from "../profileLabels";
import { setAtPath, type PathSegment } from "../profilePath";
import { PROFILE_FORM_SCHEMA } from "../profileSchema";
import { Button, Dot, ErrorText, Input } from "../ui";
import { SchemaField } from "./SchemaField";
import { BuildEditor, forbiddenHits } from "./profile/BuildEditor";

interface Section {
  id: string;
  label: string;
  /** Bu bölümün düzenlediği kök alanlar. */
  keys: string[];
  eyebrow: string;
  description: string;
  /** Gezginde, bölümde sorun ya da değişiklik yokken görünen sayı. */
  count?: (doc: ProjectProfile) => number;
}

/**
 * Bölümler tasarımın gezgininden. Kök alanlarla birebir değil: sürüm, slug ve
 * ad üç ayrı bölümdü; her biri tek satırlık bir sayfa açıyordu, "Kimlik"te
 * birleşti. git/tracker da "Çalışma disiplini"ne girdi — commit ve PR
 * politikası o disiplinin parçası.
 */
const SECTIONS: Section[] = [
  {
    id: "identity",
    label: "Kimlik",
    keys: ["version", "slug", "name"],
    eyebrow: "version · slug · name",
    description: "Profilin kimliği. Slug projeye bağlı — farklı slug'lı belgeyi sunucu kaydetmez.",
  },
  {
    id: "workspace",
    label: "Çalışma alanı",
    keys: ["workspace"],
    eyebrow: "workspace",
    description: "Repolar, varsayılan dallar ve worktree'ye taşınması gereken gitignore'lu dosyalar.",
    count: (d) => d.workspace.repos.length,
  },
  {
    id: "exec",
    label: "Konteyner",
    keys: ["exec"],
    eyebrow: "exec · konteyner",
    description: "İşin koştuğu imaj, kaynak sınırları, önbellekler ve iş başına bir kez koşan kurulum.",
  },
  {
    id: "build",
    label: "Derleme",
    keys: ["build"],
    eyebrow: "build · sıra bağlayıcıdır",
    description: "Adımlar yazıldığı sırada koşar. Ters sıra yeşil görünür ama çıktı eksik kalabilir — en pahalı hata sınıfı.",
  },
  {
    id: "services",
    label: "Servisler",
    keys: ["services"],
    eyebrow: "services · tek tanım",
    description: "Postgres, Redis gibi bağımlılıklar burada BİR KEZ tanımlanır; canlı ortam ve test takımları adıyla başvurur. Dış host verilen servise konteyner kurulmaz.",
    count: (d) => d.services.length,
  },
  {
    id: "appEnv",
    label: "Uygulama env'i",
    keys: ["appEnv"],
    eyebrow: "appEnv · tek tanım",
    description: "Canlı ortam ve servis/klon isteyen test takımları AYNI değişkenlerle beslenir. Yer tutucular: $dbCloneConnectionString (o bağlamın DB klonu), $runId (canlıda iş, testte koşu başına), $jobId, $jobIdShort, $jobIdSql.",
    count: (d) => Object.keys(d.appEnv).length,
  },
  {
    id: "test",
    label: "Testler",
    keys: ["test"],
    eyebrow: "test",
    description: "Test paketleri, baseline ve QA case onayı.",
    count: (d) => d.test.suites.length,
  },
  {
    id: "live",
    label: "Canlı ortam",
    keys: ["live"],
    eyebrow: "live",
    description: "İnsanın porttan test ettiği ortam: compose, uygulama ve kullandığı servisler (adla).",
  },
  {
    id: "database",
    label: "Veritabanı",
    keys: ["database"],
    eyebrow: "database",
    description: "Şablon DB (migrate + tohum) ve klonlama kuralları — canlı ortam ve test takımları aynı şablondan klon alır.",
  },
  {
    id: "discipline",
    label: "Çalışma disiplini",
    keys: ["workflow", "git", "tracker"],
    eyebrow: "workflow · git · tracker",
    description: "Safha onayı, commit ve PR politikası, iş takibi — motora gömülmez, buradan okunur.",
  },
  {
    id: "release",
    label: "Release",
    keys: ["release"],
    eyebrow: "release · workflow_dispatch",
    description: "Hedef repodaki release workflow'u ve zamanlı yayın takvimi. Yayının kendisi workflow'un işi; Ahtapot yalnız tetikler.",
  },
  {
    id: "security",
    label: "Güvenlik",
    keys: ["security"],
    eyebrow: "security",
    description: "Agent'ın okuyamayacağı dosyalar ve kapalı araçlar.",
  },
  {
    id: "agents",
    label: "Agent'lar ve sınırlar",
    keys: ["agents", "limits"],
    eyebrow: "agents · limits",
    description: "Rol modelleri, triage merdiveni, tur ve maliyet sınırları.",
  },
];

// Şemaya yeni kök alan eklenip buraya eklenmezse DÜŞMESİN: "Diğer"de görünür.
const ROOT_KEYS = Object.keys(PROFILE_FORM_SCHEMA.shape ?? {});
const LEFTOVER = ROOT_KEYS.filter((k) => !SECTIONS.some((s) => s.keys.includes(k)));
const ALL_SECTIONS: Section[] =
  LEFTOVER.length > 0
    ? [...SECTIONS, { id: "other", label: "Diğer", keys: LEFTOVER, eyebrow: LEFTOVER.join(" · "), description: "" }]
    : SECTIONS;

/**
 * Doğrulama satırının ait olduğu bölüm. Sunucu kimlikleri kök alan adıyla
 * başlamıyor (`repo.<ad>`, `ports`), o yüzden önek tablosu var; şema
 * hataları ise alan yoluyla gelir (`build.steps.0.run`).
 */
const CHECK_PREFIX: Record<string, string> = {
  repo: "workspace",
  referenceRepo: "workspace",
  ignoredButNeeded: "workspace",
  ports: "live",
};

function sectionOf(checkId: string): string | undefined {
  const head = checkId.split(".")[0] ?? "";
  const root = CHECK_PREFIX[head] ?? head;
  return ALL_SECTIONS.find((s) => s.keys.includes(root))?.id;
}

/** Yaprak düzeyinde fark sayısı — footer'daki "N alan değişti". */
function diffCount(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    let n = Math.abs(a.length - b.length);
    for (let i = 0; i < Math.min(a.length, b.length); i++) n += diffCount(a[i], b[i]);
    return n;
  }
  if (isRecord(a) && isRecord(b)) {
    let n = 0;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) n += diffCount(a[k], b[k]);
    return n;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? 0 : 1;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Adım kartının doğrudan okuduğu alanlar; eksikse yolu döner. */
function missingInCommand(c: unknown, at: string, isStep: boolean): string | null {
  if (!isRecord(c)) return at;
  for (const k of ["name", "run", "cwd"]) if (typeof c[k] !== "string") return `${at}.${k}`;
  if (!isRecord(c.env)) return `${at}.env`;
  if (isStep) for (const k of ["whenChanged", "exceptPaths"]) if (!Array.isArray(c[k])) return `${at}.${k}`;
  return null;
}

/** Özel bölümlerin doğrudan okuduğu diziler; yoksa ilk eksik yolu döner. */
function missingSkeleton(doc: unknown): string | null {
  if (!isRecord(doc)) return "belge";
  const b = doc.build;
  if (!isRecord(b)) return "build";
  for (const k of ["preSteps", "steps", "forbiddenFlags"]) if (!Array.isArray(b[k])) return `build.${k}`;
  // Dizinin varlığı yetmiyor: adım kartı elemanın alanlarını doğrudan okuyor
  // (`run.split`, `whenChanged.map`, `Object.keys(env)`). Ham JSON'da silinen
  // bir alan bölümlere dönünce düzenleyiciyi çökertip taslağı kaybettiriyordu.
  for (const [k, isStep] of [["preSteps", false], ["steps", true]] as const) {
    for (const [i, c] of (b[k] as unknown[]).entries()) {
      const miss = missingInCommand(c, `build.${k}.${i}`, isStep);
      if (miss) return miss;
    }
  }
  if (!isRecord(doc.workspace) || !Array.isArray(doc.workspace.repos)) return "workspace.repos";
  if (!isRecord(doc.test) || !Array.isArray(doc.test.suites)) return "test.suites";
  return null;
}

/**
 * Profil düzenleme — tasarımın "Profil düzenle" görünümü: solda bölüm
 * gezgini, sağda tek bölüm, altta değişiklik/engel özeti.
 *
 * Kayıt YENİ taslak sürüm doğurur; düzenlenen satır değişmez (onay kapısı).
 * İki tür hata var ve ayrı sayılır:
 *  - engelleyen: şema hatası ve yasak bayrak. Bunlarla kaydedilen taslak ya
 *    sunucuda reddedilir ya da build kapısında kesin kırılır.
 *  - bilgi: "Doğrula"nın ölçtükleri (dizin yok, imajda araç yok…). Workspace'e
 *    ve Docker'a bağlı, düzeltmesi profilin dışında olabilir — kaydı kesmez.
 */
export function ProfileEditor({
  projectId,
  profile,
  onCancel,
  onSaved,
}: {
  projectId: string;
  profile: ProfileFull;
  onCancel: () => void;
  onSaved: (row: ProfileRow & { droppedFields?: string[] }) => void;
}) {
  const [draft, setDraft] = useState<ProjectProfile>(() => structuredClone(profile.document));
  const [sectionId, setSectionId] = useState("build");
  const [raw, setRaw] = useState<{ text: string; error: string | null } | null>(null);
  const [note, setNote] = useState("");

  const profiles = useQuery({ queryKey: ["profiles", projectId], queryFn: () => api.profiles(projectId) });
  const nextVersion = Math.max(profile.version, ...(profiles.data ?? []).map((p) => p.version)) + 1;

  const save = useMutation({ mutationFn: () => api.saveProfile(projectId, draft, note), onSuccess: onSaved });
  const validation = useMutation({
    mutationFn: (doc: ProjectProfile) =>
      api.validateProfileDraft(projectId, doc).then((r) => ({ ...r, json: JSON.stringify(doc) })),
  });

  const json = JSON.stringify(draft);
  const validationStale = validation.data != null && validation.data.json !== json;

  // Engelleyen hatalar her tuşta yeniden ölçülür — "Doğrula"ya basmadan
  // kaydın neden kapalı olduğu görünmeli.
  const blocking = useMemo<ValidationCheck[]>(() => {
    const out: ValidationCheck[] = [];
    const parsed = ProjectProfileSchema.safeParse(draft);
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        out.push({ id: i.path.map(String).join(".") || "document", level: "error", message: i.message });
      }
    }
    for (const h of forbiddenHits(draft.build)) {
      out.push({ id: "build.forbiddenFlags", level: "error", message: `yasak bayrak: "${h.flag}" (adım: ${h.step})` });
    }
    return out;
  }, [draft]);
  const rawBroken = raw?.error != null;

  const serverChecks = (validation.data?.checks ?? []).filter((c) => c.level === "error" || c.level === "warn");
  const original = profile.document as unknown as Record<string, unknown>;
  const current = draft as unknown as Record<string, unknown>;
  const changes = ALL_SECTIONS.map((s) => ({
    section: s,
    n: s.keys.reduce((sum, k) => sum + diffCount(original[k], current[k]), 0),
  })).filter((c) => c.n > 0);
  const changedTotal = changes.reduce((s, c) => s + c.n, 0);

  const section = ALL_SECTIONS.find((s) => s.id === sectionId) ?? ALL_SECTIONS[0]!;
  const errorsIn = (id: string) =>
    blocking.some((c) => sectionOf(c.id) === id) || serverChecks.some((c) => c.level === "error" && sectionOf(c.id) === id);

  const handle = (path: PathSegment[], value: unknown) => setDraft(setAtPath(draft, path, value));

  // Bölüm başındaki sorun listesi. Derlemede adım kartları kendi hatasını
  // gösteriyor; aynı satırı iki kez yazmamak için onlar burada atlanır.
  // Doğrulama ESKİYSE kartlar sunucu satırı almıyor (`checks={[]}`): o zaman
  // atlamak hatayı hiçbir yerde göstermemek olurdu — gezginde kırmızı nokta
  // yanıyor, metin yok.
  const stepNames = new Set([...draft.build.preSteps, ...draft.build.steps].map((s) => `build.${s.name}.`));
  const sectionIssues = [...blocking, ...serverChecks].filter((c) => {
    const s = sectionOf(c.id);
    if (section.id === "build" && c.id === "build.forbiddenFlags") return false;
    if (section.id === "build" && !validationStale && [...stepNames].some((p) => c.id.startsWith(p))) {
      return false;
    }
    // Bölümü bilinmeyen satır kaybolmasın: Kimlik'te görünür.
    return s === section.id || (s === undefined && section.id === "identity");
  });

  return (
    <div className="grid min-h-0 grid-cols-1 bg-surface md:h-[min(80vh,880px)] md:grid-cols-[200px_minmax(0,1fr)]">
      <nav className="flex min-w-0 flex-col gap-0.5 overflow-auto border-b border-edge bg-raised px-2.5 py-3.5 md:border-r md:border-b-0">
        <span className="px-2 pb-2 font-mono text-[10.5px] uppercase tracking-[.1em] text-ink-muted">Bölümler</span>
        {ALL_SECTIONS.map((s) => {
          const active = !raw && s.id === section.id;
          const bad = errorsIn(s.id);
          const changed = changes.some((c) => c.section.id === s.id);
          const count = s.count?.(draft);
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setRaw(null);
                setSectionId(s.id);
              }}
              disabled={rawBroken}
              className={`flex items-center gap-2 rounded-lg px-[9px] py-[7px] text-left text-[12.5px] disabled:opacity-50 ${
                active ? "bg-brand-tint font-semibold text-brand-ink" : "text-ink-body hover:bg-surface"
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
              {bad ? (
                <Dot tone="err" size={6} />
              ) : changed ? (
                <span className="font-mono text-[10.5px] font-normal text-wait-ink">değişti</span>
              ) : count ? (
                <span className="font-mono text-[10.5px] font-normal text-ink-muted">{count}</span>
              ) : null}
            </button>
          );
        })}
        <div className="flex-1" />
        <button
          type="button"
          disabled={rawBroken}
          onClick={() => setRaw(raw ? null : { text: JSON.stringify(draft, null, 2), error: null })}
          className="mt-2 border-t border-edge p-[9px] text-left text-[12px] text-ink-muted hover:text-ink disabled:opacity-50"
        >
          {raw ? "← Bölümlere dön" : "Ham JSON'da düzenle ↗"}
        </button>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="min-h-0 flex-1 overflow-auto px-6 pt-5 pb-6">
          <div className="flex max-w-[82ch] flex-col gap-[18px]">
            {raw ? (
              <>
                <SectionHead eyebrow="profil · json" title="Ham JSON">
                  Tüm belge. Geçerli JSON her tuşta forma yansır; çözülemeyen metin kaydı ve bölüm geçişini kapatır.
                </SectionHead>
                <textarea
                  value={raw.text}
                  spellCheck={false}
                  onChange={(e) => {
                    const text = e.target.value;
                    try {
                      const parsed: unknown = JSON.parse(text);
                      // Bölümler belgenin iskeletine güveniyor (build.steps
                      // dizisi vb.); iskeleti bozan JSON forma geçmez, burada kalır.
                      const missing = missingSkeleton(parsed);
                      if (missing) throw new Error(`${missing} eksik ya da biçimi yanlış`);
                      setDraft(parsed as ProjectProfile);
                      setRaw({ text, error: null });
                    } catch (err) {
                      setRaw({ text, error: err instanceof Error ? err.message : String(err) });
                    }
                  }}
                  className={`min-h-[60vh] w-full resize-y rounded-[10px] border bg-log px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] text-ink focus:outline-none ${
                    raw.error ? "border-err" : "border-edge-control focus:border-brand"
                  }`}
                />
                {raw.error && <div className="text-[12.5px] text-err-text">JSON çözülemedi: {raw.error}</div>}
              </>
            ) : (
              <>
                <SectionHead eyebrow={section.eyebrow} title={section.label}>
                  {section.description}
                </SectionHead>

                {sectionIssues.length > 0 && <IssueList checks={sectionIssues} stale={validationStale} />}

                {section.id === "identity" ? (
                  <IdentityCard draft={draft} version={profile.version} onChange={handle} />
                ) : section.id === "build" ? (
                  <BuildEditor
                    build={draft.build}
                    onChange={(build) => setDraft({ ...draft, build })}
                    checks={validationStale ? [] : serverChecks}
                  />
                ) : (
                  <GenericSection keys={section.keys} draft={draft} onChange={handle} />
                )}
              </>
            )}
          </div>
        </div>

        <footer className="flex flex-wrap items-center gap-3 border-t border-edge bg-raised px-5 py-3">
          <Dot tone={changedTotal > 0 ? "wait" : "off"} size={8} />
          <span className="text-[12.5px] text-ink-body">
            {changedTotal > 0 ? (
              <>
                <strong className="font-semibold text-ink">{changedTotal} alan değişti</strong>
                {changes.map((c) => ` · ${c.section.label} ${c.n}`).join("")}
              </>
            ) : (
              "değişiklik yok"
            )}
          </span>
          <span className="font-mono text-[11px] text-ink-muted">
            v{profile.version} {profile.status === "draft" ? "taslağı" : ""} üzerine yazılmaz →{" "}
            <strong className="font-semibold text-ink-body">v{nextVersion} taslak</strong> oluşur
          </span>
          <span className="flex-1" />
          {validation.data && (
            <span className="font-mono text-[11px] text-ink-muted">
              {validationStale ? "doğrulama eski" : `doğrulama: ${validation.data.errors} hata · ${validation.data.warnings} uyarı`}
            </span>
          )}
          {(blocking.length > 0 || rawBroken) && (
            <span className="text-[12.5px] text-err-text">
              {rawBroken ? "JSON çözülemiyor" : `${blocking.length} hata kaydı engelliyor`}
            </span>
          )}
          <Input
            className="h-8 w-48 text-[12px]"
            placeholder="not (neden, opsiyonel)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button variant="neutral" size="sm" className="h-8 text-[12.5px]" onClick={onCancel}>
            Vazgeç
          </Button>
          <Button
            variant="neutral"
            size="sm"
            className="h-8 text-[12.5px]"
            disabled={validation.isPending || rawBroken}
            onClick={() => validation.mutate(draft)}
          >
            {validation.isPending ? "Doğrulanıyor…" : "Doğrula"}
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="h-8 text-[12.5px] disabled:opacity-55"
            disabled={save.isPending || changedTotal === 0 || blocking.length > 0 || rawBroken}
            title={changedTotal === 0 ? "Değişiklik yok" : blocking.length > 0 ? "Önce engelleyen hataları gider" : undefined}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Kaydediliyor…" : "Taslak olarak kaydet"}
          </Button>
        </footer>
        {(save.error != null || validation.error != null) && (
          <div className="border-t border-edge px-5 py-2">
            <ErrorText error={save.error ?? validation.error} />
          </div>
        )}
      </div>
    </div>
  );
}

function SectionHead({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[5px]">
      <span className="font-mono text-[10.5px] uppercase tracking-[.1em] text-ink-muted">{eyebrow}</span>
      <h3 className="text-[20px] font-semibold tracking-[-.01em] text-ink">{title}</h3>
      {children && <p className="text-[13px] leading-[1.55] text-ink-soft text-pretty">{children}</p>}
    </div>
  );
}

function IssueList({ checks, stale }: { checks: ValidationCheck[]; stale: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-err-edge bg-err-tint px-[15px] py-3">
      {checks.map((c, i) => (
        <div key={`${c.id}-${i}`} className="flex items-start gap-2.5 text-[12.5px] leading-[1.55]">
          <span
            className={`mt-px shrink-0 rounded-[5px] px-[7px] py-px font-mono text-[10.5px] font-semibold ${
              c.level === "error" ? "bg-err/12 text-err-ink" : "bg-wait/15 text-wait-ink"
            }`}
          >
            {c.id}
          </span>
          <span className="min-w-0 flex-1 text-err-body">{c.message}</span>
        </div>
      ))}
      {stale && <span className="font-mono text-[10.5px] text-ink-muted">doğrulama son değişiklikten önce — yeniden doğrula</span>}
    </div>
  );
}

/**
 * Sürüm, slug ve ad tek kartta. Sürüm ŞEMA sürümüdür (`literal(1)`), profil
 * sürümü değil — elle değişmez. Slug projeye bağlı; sunucu farklısını
 * reddettiği için burada da salt-okunur.
 */
function IdentityCard({
  draft,
  version,
  onChange,
}: {
  draft: ProjectProfile;
  version: number;
  onChange: (path: PathSegment[], value: unknown) => void;
}) {
  const lbl = "font-mono text-[10px] uppercase tracking-[.06em] text-ink-muted";
  const ro = "rounded-lg border border-edge bg-raised px-[9px] py-1.5 font-mono text-[12px] text-ink-body";
  return (
    <div className="grid grid-cols-1 gap-3 rounded-xl border border-edge bg-surface px-3.5 py-3 md:grid-cols-[110px_200px_minmax(0,1fr)]">
      <label className="flex flex-col gap-1">
        <span className={lbl}>{labelFor("version", "version")}</span>
        <span className={ro}>{draft.version}</span>
        <span className="text-[11px] text-ink-dim">şema · profil v{version}</span>
      </label>
      <label className="flex flex-col gap-1">
        <span className={lbl}>{labelFor("slug", "slug")}</span>
        <span className={`${ro} truncate`}>{draft.slug}</span>
        <span className="text-[11px] text-ink-dim">projeye bağlı</span>
      </label>
      <label className="flex flex-col gap-1">
        <span className={lbl}>{labelFor("name", "name")}</span>
        <input
          value={draft.name}
          onChange={(e) => onChange(["name"], e.target.value)}
          className="rounded-lg border border-edge-control bg-surface px-[9px] py-1.5 text-[12.5px] text-ink focus:border-brand focus:outline-none"
        />
        <span className="text-[11px] text-ink-dim">ekranlarda görünen ad</span>
      </label>
    </div>
  );
}

/**
 * Genel şema formu. Tek kök alanlı bölümde alanın kendi başlığı atlanır —
 * bölüm başlığı zaten o; iç içe ikinci bir "Konteyner" kutusu gürültüydü.
 */
function GenericSection({
  keys,
  draft,
  onChange,
}: {
  keys: string[];
  draft: ProjectProfile;
  onChange: (path: PathSegment[], value: unknown) => void;
}) {
  const shape = PROFILE_FORM_SCHEMA.shape ?? {};
  const doc = draft as unknown as Record<string, unknown>;
  const only = keys.length === 1 ? keys[0] : undefined;
  const spec = only ? shape[only] : undefined;
  const value = only ? doc[only] : undefined;

  if (only && spec?.kind === "object" && isRecord(value)) {
    return (
      <div className="flex flex-col gap-3">
        {Object.entries(spec.shape ?? {}).map(([k, child]) => (
          <SchemaField key={k} spec={child} value={value[k]} path={[only, k]} onChange={onChange} />
        ))}
        {spec.isOptional && (
          <Button type="button" variant="danger" size="sm" className="self-start" onClick={() => onChange([only], undefined)}>
            {labelFor(only, only)} bölümünü kaldır
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {keys.map((k) => {
        const s = shape[k];
        return s ? <SchemaField key={k} spec={s} value={doc[k]} path={[k]} onChange={onChange} /> : null;
      })}
    </div>
  );
}
