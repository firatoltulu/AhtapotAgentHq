import { BRAND } from "@ahtapot/shared";

import type { FilesPrState, GitHubClient } from "../git/github.js";

/**
 * Bağlanan her workspace'in reposuna önerilen issue şablonları (task + bug).
 *
 * Neden motorda: issue gövdesi ve yorumları olduğu gibi işin açıklaması olur
 * (`Jobs.tsx` → Planner'ın ilk bağlamı). Serbest metin issue'larda amaç,
 * kabul ölçütü ya da tekrar üretme adımı çoğu zaman yok; Planner eksiği
 * varsayımla dolduruyor. Alanlı bir form bu boşlukları issue AÇILIRKEN
 * kapatır — girdiyi biçimlemek çıktıyı düzeltmekten ucuz.
 *
 * Neden PR: hedef repo insanındır. Dosyalar doğrudan varsayılan dala
 * yazılmaz; PR bir öneridir, birleştirmek ya da kapatmak insanın kararı.
 * Kapatılmış PR "istenmiyor" demektir ve otomatik olarak bir daha açılmaz.
 *
 * Aynı yoldaki dosya repoda zaten varsa (projenin kendi `bug.yml`'i gibi)
 * ÜZERİNE YAZILMAZ; PR yalnız eksik dosyaları taşır.
 */

export const ISSUE_TEMPLATE_BRANCH = `${BRAND.slug}/issue-templates`;

const TASK_YML = `name: Görev
description: Yeni özellik, değişiklik ya da iyileştirme isteği.
labels: ["task"]
body:
  - type: markdown
    attributes:
      value: |
        Alanlar işi alan kişinin (ya da agent'ın) varsayım yapmadan başlayabilmesi için var.
        Token, parola, bağlantı dizesi gibi sırları **yapıştırmayın**.
  - type: textarea
    id: goal
    attributes:
      label: Amaç
      description: Bu iş neden yapılıyor? Hangi sorunu çözüyor, kime ne kazandırıyor?
      placeholder: Mağaza yöneticileri iade taleplerini toplu onaylayamıyor; her birini tek tek açmak zorunda.
    validations:
      required: true
  - type: textarea
    id: request
    attributes:
      label: İstenen
      description: Ne yapılmalı? Davranışı kullanıcının gözünden anlatın.
      placeholder: İade listesinde çoklu seçim ve "Seçilenleri onayla" düğmesi olsun.
    validations:
      required: true
  - type: textarea
    id: acceptance
    attributes:
      label: Kabul ölçütleri
      description: İş bittiğinde doğrulanabilir maddeler. Her madde test edilebilir olmalı.
      value: |
        - [ ]
    validations:
      required: true
  - type: textarea
    id: out-of-scope
    attributes:
      label: Kapsam dışı
      description: Bu işte bilerek yapılmayacaklar. Sınır çizmek işin şişmesini önler.
    validations:
      required: false
  - type: textarea
    id: references
    attributes:
      label: İlgili dosyalar, ekranlar, emsal
      description: Başlanacak yer, benzer bir özelliğin bulunduğu modül, ilgili ekran ya da endpoint.
    validations:
      required: false
  - type: textarea
    id: context
    attributes:
      label: Ek bağlam
      description: Tasarım, bağlantı, ekran görüntüsü, iş kuralı.
    validations:
      required: false
`;

const BUG_YML = `name: Hata
description: Beklendiği gibi çalışmayan bir davranış bildirin.
labels: ["bug"]
body:
  - type: markdown
    attributes:
      value: |
        Hatayı yeniden üretebilmek düzeltmenin yarısıdır; adımları olabildiğince somut yazın.
        Log yapıştırırken token, parola, bağlantı dizesi gibi sırları **silin**.
  - type: textarea
    id: summary
    attributes:
      label: Özet
      description: Ne bozuk? Bir iki cümle.
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: Yeniden üretme adımları
      description: Hatayı gören birinin izlediği adımlar, sırasıyla.
      value: |
        1.
        2.
        3.
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: Beklenen davranış
    validations:
      required: true
  - type: textarea
    id: actual
    attributes:
      label: Gerçekleşen davranış
      description: Görülen sonuç ve varsa hata mesajı.
    validations:
      required: true
  - type: dropdown
    id: severity
    attributes:
      label: Önem
      options:
        - Kritik — canlıda iş duruyor
        - Yüksek — önemli bir akış bozuk, geçici çözüm yok
        - Orta — geçici çözüm var
        - Düşük — kozmetik
    validations:
      required: true
  - type: textarea
    id: environment
    attributes:
      label: Ortam
      description: Sürüm ya da dal, ortam (canlı/test/yerel), tarayıcı, ilgili kiracı ya da kayıt.
    validations:
      required: false
  - type: textarea
    id: logs
    attributes:
      label: Log ve ekran görüntüsü
      description: İlgili log satırları, stack trace, ekran görüntüsü.
    validations:
      required: false
`;

// Boş issue kapalı: standardın amacı her işin aynı alanlarla açılması.
// Projenin kendi `config.yml`'i varsa bu dosya önerilmez (üzerine yazılmaz).
const CONFIG_YML = `blank_issues_enabled: false
`;

export const ISSUE_TEMPLATE_FILES: readonly { path: string; content: string }[] = [
  { path: ".github/ISSUE_TEMPLATE/task.yml", content: TASK_YML },
  { path: ".github/ISSUE_TEMPLATE/bug.yml", content: BUG_YML },
  { path: ".github/ISSUE_TEMPLATE/config.yml", content: CONFIG_YML },
];

export type IssueTemplateStatus =
  | FilesPrState
  | { state: "opened"; url: string; paths: string[] };

/** Salt okunur durum — proje sayfası bunu gösterir. */
export async function issueTemplateStatus(gh: GitHubClient, repo: string): Promise<FilesPrState> {
  if (!gh.filesPrState) throw new Error("GitHub istemcisi dosya PR'ı desteklemiyor");
  return gh.filesPrState(repo, ISSUE_TEMPLATE_BRANCH, ISSUE_TEMPLATE_FILES.map((f) => f.path));
}

/**
 * Eksik şablonlar için PR açar; zaten varsa, PR bekliyorsa ya da insan PR'ı
 * kapattıysa hiçbir şey yazmaz ve durumu döndürür. Idempotent — bağlanma
 * akışı da düğme de aynı yolu çağırır.
 */
export async function proposeIssueTemplates(gh: GitHubClient, repo: string): Promise<IssueTemplateStatus> {
  const status = await issueTemplateStatus(gh, repo);
  if (status.state !== "missing") return status;
  if (!gh.openFilesPr) throw new Error("GitHub istemcisi dosya PR'ı desteklemiyor");
  const files = ISSUE_TEMPLATE_FILES.filter((f) => status.missing.includes(f.path));
  const pr = await gh.openFilesPr(repo, {
    base: status.defaultBranch,
    branch: ISSUE_TEMPLATE_BRANCH,
    title: "Issue şablonları: görev ve hata",
    message: "chore: issue şablonları (görev, hata)",
    body: [
      `${BRAND.displayName} bu repoya bağlandı. Issue'lar ${BRAND.displayName}'ta işe dönüşürken gövdesi agent'ın ilk bağlamı oluyor;`,
      "alanlı şablonlar amaç, kabul ölçütü ve yeniden üretme adımı gibi bilgilerin baştan yazılmasını sağlar.",
      "",
      "Eklenen dosyalar:",
      ...files.map((f) => `- \`${f.path}\``),
      "",
      "Repoda aynı yolda bulunan dosyalara dokunulmadı. Bu PR'ı kapatırsanız tekrar önerilmez.",
    ].join("\n"),
    files,
  });
  return { state: "opened", url: pr.url, paths: files.map((f) => f.path) };
}
