# İkinci göz: plan ve test senaryolarını ikinci bir model eleştirir

Durum: **uygulandı, derlendi; gerçek bir sağlayıcıyla ve gerçek bir işte
denenmedi** (2026-10-17). Sapmalar en altta.
Karar özeti: [§42](01-decisions.md).

## Amaç

Kullanıcının yazdığı iş tanımı dağınık olabiliyor: istekler paragraf içinde
kayboluyor, bir kısmı örtük kalıyor. Planner bugün bu metni doğrudan plana
çeviriyor; plan onayında insan, metnin **nasıl anlaşıldığını** ayrıca
görmüyor. Test senaryoları da (§21) aynı ham metinden besleniyor.

İki parça:

1. **Claude metni düzenler.** Planner, ham metinden numaralı bir
   **gereksinim listesi** çıkarır (her biri özgün metinden alıntıyla), her
   safha karşıladığı gereksinimleri işaretler. Tester her senaryoya
   doğruladığı gereksinimleri yazar. Ham metin değişmez (`jobs.description`
   hiç güncellenmiyor; öyle kalır).
2. **İkinci model eleştirir.** Profilde açıksa, yerel incelemede (§20)
   tanımlı sağlayıcının modeli üç metni karşılaştırır — ham metin,
   gereksinimler, plan (ya da senaryolar) — ve bulgu yazar. Bulgular insana
   **danışman notu** olarak gösterilir.

## Neden bu rol paylaşımı

- **Üretici Claude:** repoyu, kod haritasını (§35), profili, emsali gören o.
  "Şu ekrandaki düğme"yi ancak bağlamı olan doğru açar.
- **Eleştirmen ikinci model:** iş metinleri karşılaştırmak; repo bağlamı
  gerekmez. Bağlamsız bir modele yeniden YAZDIRMAK niyeti düzgün ama yanlış
  cümlelerle doldururdu; eleştirmenin yanılması en kötü ihtimalle gereksiz
  bir not. Farklı model, Claude'un kendi yorumundaki kör noktayı yakalar.
- **Neden ayrı sağlayıcı tanımı değil:** anahtar, uç nokta ve protokol
  `review.local`ta zaten tanımlı ve ölçülü (§20). Model ayrıca seçilebilir.

## Akış

```
Planning ── plannerTurn → savePlan → plan kapısı açılır → PlanReview
                                         │
                                         └─(review.critic.plan) critiquePlan  ── arka planda, kapıyı BEKLETMEZ
                                                └─ critiques satırı: running → ready | failed | skipped

Senaryo üretimi (PlanReview düğmesi / LiveTest tarayıcı turu)
  produceScenarios → satır ready
        └─(review.critic.scenarios) critiqueScenarios ── arka planda
```

- **Akışı durdurmaz, kapı açmaz** (§20 ilkesi): anahtar yok, sağlayıcı
  düştü, süre doldu, blok şemaya uymadı → satır `failed`/`skipped` + sebep,
  akışa not; kapı zaten açık.
- **Bulgu Planner'a kendiliğinden gitmez** (§41 ile aynı gerekçe): LLM
  kararı belirlenimci değil, yanlış bir bulgu plan turunu boşuna yakar.
  İnsan seçtiği bulguları tek tıkla ret yorumuna ekler; mevcut red yolu
  (`decide` → Planning) aynen çalışır.
- **Her plan sürümü ayrı eleştirilir:** red ya da insan düzenlemesiyle yeni
  sürüm `under_review` olunca yeniden koşar; eski sürümün eleştirisi
  sürüme bağlı kalır.
- **Kural 3:** eleştirmen `CRITIQUE_JSON` yazar → `extractBlock` → Zod.
  **Sentez yok:** blok yoksa "bulgu yok" uydurmak insanı yanıltırdı; satır
  `failed` olur. Bulgu düzeyinde bilinmeyen `kind` `other`e düşer.
- **Kural 4:** sağlayıcıya giden üç metin ve dönen her şey `scrubSecrets`ten
  geçer. Hata mesajı da.
- **Kural 5:** anahtar her çağrıda `readReviewKey` ile okunur, yalnız
  isteğin başlığına girer; `process.env`'e ve log'a yazılmaz.
- **Kural 6:** kota/hata yalnız HTTP durumundan ve hata gövdesinden okunur.
  Claude havuzu etkilenmez — ayrı anahtar.

## Profil

`workflow.review.critic` (yeni, `WorkflowSchema.review` içinde; bu belgede
kısaca `review.critic`, yerel inceleme de `review.local` diye geçer):

```ts
export const CriticSchema = z.object({
  /** Plan onayında planı eleştir. */
  plan: z.boolean().default(false),
  /** Test senaryoları hazır olunca eleştir. */
  scenarios: z.boolean().default(false),
  /** Boşsa `review.local.model`. Aynı uç noktada başka model seçmek için. */
  model: z.string().min(1).optional(),
  maxOutputTokens: z.number().int().positive().default(8_000),
  timeoutSeconds: z.number().int().positive().default(180),
}).prefault({});
```

- Sağlayıcı (`protocol`, `baseUrl`, `keyRef`) `review.local`tan okunur;
  `review.local.enabled` **gerekmez** — OCR kapalıyken de eleştirmen açık
  olabilir.
- `superRefine` (`workflow.review` düzeyinde): `plan || scenarios` ise
  `workflow.review.local.keyRef` ve
  (`workflow.review.critic.model ?? workflow.review.local.model`) zorunlu.
- Varsayılan iki bayrak da kapalı: eski profiller değişmeden geçer.

## Şemalar (`packages/shared`)

`job.ts`:

```ts
export const RequirementSchema = z.object({
  id: z.string().min(1),            // "R1"
  text: z.string().min(1),          // düzenlenmiş, doğrulanabilir cümle
  source: z.string().default(""),   // ham metinden alıntı; örtükse boş
});
// PlanDocumentSchema'ya:  requirements: z.array(RequirementSchema).default([])
// PlanPhaseSchema'ya:     covers: z.array(z.string()).default([])
// TestScenarioSchema'ya:  covers: z.array(z.string()).default([])

export const CritiqueFindingSchema = z.object({
  kind: z.enum([
    "missing_requirement",   // ham metinde var, gereksinimlerde/planda yok
    "unrequested_scope",     // planda var, istenmemiş
    "hidden_assumption",     // sessiz varsayım — açık soru olmalıydı
    "ambiguity",             // gereksinim iki türlü okunuyor
    "uncovered_requirement", // hiçbir safha/senaryo karşılamıyor
    "missing_edge_case",
    "wrong_expectation",     // senaryonun beklenen sonucu gereksinimle çelişiyor
    "other",
  ]).catch("other"),
  ref: z.string().default(""),          // R2, safha id'si, senaryo id'si
  text: z.string().min(1),
  suggestion: z.string().default(""),
});
export const CritiqueDocumentSchema = z.object({
  verdict: z.enum(["ok", "concerns"]),
  findings: z.array(CritiqueFindingSchema),
  notes: z.string().default(""),
});
export const CRITIQUE_SUBJECTS = ["plan", "scenarios"] as const;
```

Eski planlar/senaryolar `default([])` ile okunur; `requirements` boşsa UI
bölümü göstermez, eleştirmen yalnız ham metin + planla çalışır.

WS: `critique.updated` olayı (`{ critiqueId, subject, subjectId, status }`)
— UI'ın yeniden çekmesi için. Olayın kendisi DB'ye `job_events` yoluyla
gider; içerik değil, kimlik taşır.

## Veritabanı

Yeni tablo `critiques` (taşınabilirlik kurallarına uygun):

| Sütun | Tip |
|---|---|
| `id` | TEXT UUIDv7 |
| `job_id` | TEXT → jobs |
| `subject` | TEXT (`plan` \| `scenarios`) |
| `subject_id` | TEXT — `plans.id` ya da `test_scenarios.id` |
| `status` | TEXT (`running` \| `ready` \| `failed` \| `skipped`) |
| `model` | TEXT |
| `document` | TEXT JSON `$type<CritiqueDocument>`, nullable |
| `error` | TEXT nullable |
| `input_tokens`, `output_tokens` | INTEGER nullable |
| `created_at`, `finished_at` | TEXT ISO |

Index `(job_id, subject_id)`. Sütun `plans`/`test_scenarios`a değil, ayrı
tablo: yeniden koşma her seferinde yeni satır, geçmiş kalır.
`npm run db:generate -w @ahtapot/server`.

`engine/reconcile.ts`: açılışta `running` satırlar `failed` ("sunucu yeniden
başladı") — `test_scenarios` için yapılanın aynısı (kural 2'nin ruhu).

Maliyet `cost_records`a yazılmaz (§20 ile aynı sınır: fiyat tablosu
sağlayıcıya göre değişir); token sayısı satırda ve notta.

## Sunucu

1. **`review/llm.ts` — ince sağlayıcı istemcisi.** Sunucuda bugün bu
   sağlayıcılarla doğrudan konuşan kod yok (OCR yapılandırmayı CLI'ya
   geçiriyor). `fetch` + `AbortSignal.timeout`, asla fırlatmaz:

   ```ts
   completeText(opts: {
     protocol: "openai" | "openai-responses" | "anthropic";
     baseUrl?: string; model: string; key: string;
     system: string; user: string;
     maxOutputTokens: number; timeoutMs: number;
   }): Promise<{ ok: true; text: string; usage?: { input: number; output: number } }
             | { ok: false; reason: string }>
   ```

   | Protokol | Uç | Token parametresi |
   |---|---|---|
   | `openai-responses` | `POST /v1/responses` (`instructions` + `input`) | `max_output_tokens` |
   | `openai` | `POST /v1/chat/completions` | `max_completion_tokens` |
   | `anthropic` | `POST /v1/messages`, `x-api-key`, `anthropic-version` | `max_tokens` |

   `temperature` **gönderilmez** — GPT-6 `temperature: 0`ı 400 ile
   reddediyor (§20, ölçüldü). Varsayılan uçlar `ocr.ts`teki
   `DEFAULT_BASE_URL`dan; tek yere taşınır. `reason` `scrubSecrets`ten geçer.

2. **`review/critic.ts`** — prompt derleme ve ayrıştırma; motoru bilmez.
   `buildPlanCritique(job, plan)`, `buildScenariosCritique(job, plan, doc)`,
   `parseCritique(text)` (`extractBlock(…, "CRITIQUE_JSON")` + Zod).
   Sistem promptu `agents/core/critic.md`.

3. **`engine/job.ts`**
   - `critiquePlan(jobId, planId)`: `review.critic.plan` kapalıysa hiçbir şey
     yapmaz. Anahtar yoksa satır `skipped` + not. Plan kapısı açıldıktan
     SONRA çağrılır (`openApproval(..."plan"...)` sonrası ve `decide`'ın yeni
     sürüm yazdığı yerler), beklenmez (`void` + hata yakalanıp satıra yazılır).
   - `critiqueScenarios(jobId, rowId)`: `produceScenarios` satırı `ready`
     yaptıktan sonra. Tarayıcı turunu (§41) bekletmez.
   - Her ikisi: satır `running` yazılır → istek → `ready`/`failed`, denetim
     izi (`critique.run`), `critique.updated` olayı, kısa not:
     "İkinci göz (model): N bulgu".
   - Ham metin prompt'a planner'daki gibi kesilerek girer (4000 karakter).

4. **API** (`api/approvals.ts` yanında):
   - `GET /api/jobs/:id/critiques?subjectId=` — son satır(lar).
   - `POST /api/jobs/:id/critiques` `{ subject, subjectId }` — elle yeniden
     incele (profil bayrağı kapalıysa da sağlayıcı tanımlıysa çalışır; insan
     istedi).

## Promptlar (`agents/core`)

- **`planner.md`:** PLAN_JSON'a `requirements` — ham metindeki her istek
  bir gereksinim; `source` alıntı, örtük olanlar `source: ""` ile ve
  `openQuestions`ta sorulur. Her safhada `covers`. Gereksinim uydurma:
  metinde ve bağlamda olmayan istek `outOfScope`'a.
- **`tester.md`** + `renderTestScenariosPrompt`: gereksinim listesi girdiye
  eklenir; her senaryo `covers` yazar; her gereksinim en az bir senaryoyla
  karşılanır, karşılanamıyorsa `notes`ta söylenir.
- **`critic.md`** (yeni): rol "eleştirmen, yazar değil" — yeniden yazma,
  plan önerme yok; yalnız tutarsızlık bul. Her bulgu bir `ref`e bağlı. Emin
  olmadığında bulgu yazma (precision > recall; insanın dikkati kısıtlı).
  Çıktı tek `CRITIQUE_JSON` bloğu.

## UI (`packages/web`)

- **`PlanReader`:** "Gereksinimler" bölümü — her satırda alıntı (ham metne
  göre) ve karşılayan safhalar; hiçbir safhaya bağlı olmayan gereksinim
  vurgulu. `requirements` boşsa bölüm yok.
- **`PlanPanel` / `PlanTab`:** "İkinci göz" kartı — durum (koşuyor / hazır /
  koşamadı + sebep), model, bulgular `kind`e göre gruplu, `ref` tıklanınca
  ilgili gereksinim/safhaya kayar. Bulgu başına onay kutusu + "Seçilenleri
  geri bildirime ekle" → karar çubuğundaki yorum alanına ekler (JobDetail).
  "Yeniden incele" düğmesi.
- **`TestScenariosCard`:** senaryoda `covers` çipleri; karşılanmamış
  gereksinim uyarısı; aynı "İkinci göz" kartı.
- **Profil düzenleme:** İnceleme bölümüne "İkinci göz" alt başlığı: iki
  anahtar (plan, senaryolar), model (boşsa yerel incelemeninki), süre ve
  token tavanı. Sağlayıcı yerel incelemeden geldiği yazılır; `keyRef`/model
  eksikse uyarı.

## Uygulama sırası (küçük PR'lar)

| PR | İçerik | Tek başına değeri |
|---|---|---|
| 1 | `requirements`/`covers` şemaları + `planner.md`/`tester.md` + `renderTestScenariosPrompt` + PlanReader'da gereksinim bölümü | Dağınık metnin düzenlenmiş hali insanın önünde — eleştirmen olmadan da |
| 2 | `CriticSchema` profil + `critiques` tablosu/migration + `Critique*` şemaları + WS olayı + profil etiketleri | Altyapı; ayarlar profil ekranında (editör şemadan üretiliyor, yalnız etiket gerekti) |
| 3 | `llm.ts` + `critic.ts` + `critic.md` + motor bağlantısı + reconcile + API | Eleştiri üretilir, not düşer |
| 4 | İkinci göz kartları + geri bildirime ekle + profil düzenleme | İnsan bulguları görür ve kullanır |

Her PR sonunda `npx tsc -b` ve `npm run build`. Testleri insan koşar;
yazılacaksa kusur yakalayabilecek olanlar: `completeText`in üç protokolün
yanıt gövdesini ayrıştırması (sahte `fetch`), `CritiqueDocumentSchema`nın
bilinmeyen `kind`i `other`e düşürmesi, eski PLAN_JSON'un `requirements`
olmadan okunması, `superRefine`ın eksik `keyRef`i yakalaması.

## Plandan sapmalar (uygulamada)

- **Gereksinim bölümü `PlanTab`ta.** PR 1 bölümü `PlanReader`a (`planDoc.ts`)
  ekledi; o bileşeni kullanan `PlanPanel` hiçbir yerde çizilmiyor — bölüm
  ekranda görünmüyordu. PR 4 aynı bölümü asıl plan ekranına (`PlanExtras`)
  koydu; `planDoc.ts`teki kopya zararsız, ölü bileşenle birlikte durur.
- **Bulgu "geri bildirime ekle" düğmesiyle değil, onay kutusuyla.** Değişiklikler
  sekmesinin satır yorumlarıyla aynı kalıp: işaretli bulgular "Reddet"
  açılınca gerekçeye önceden yazılır, insan düzenleyip gönderir.
- **Senaryo bulguları red gerekçesine taşınmaz:** canlı testte red
  Developer'a gider, bulgu ise listenin kalitesine dair.
- **Elle yeniden inceleme profil bayrağına bakmaz** (insan istedi); bayrak
  kapalıyken satır olmadığı için kart da düğme de görünmez.
- **Kesilmiş yanıt hazır sayılmaz:** token tavanında kesilen yanıt, blok
  okunabilse bile `failed` (CodeRabbit, #182).
- **Ham iş tanımı `<raw_job>` etiketinde:** açıklamadaki bir başlık prompt
  düzenini taklit edemesin; kapanış etiketi kaçışlanır (CodeRabbit, #182).
- Çitsiz JSON KABUL EDİLMEZ — sözleşme tek; model çit kuralına uymadığı
  ölçülürse ayrıca açılır.

## Açık konular

- `openai` (Chat Completions) router'larda `max_completion_tokens`ı
  tanımayan olabilir — ilk gerçek koşuda ölçülecek; gerekirse protokol
  başına parametre adı.
- Eleştiri gecikmesi: plan + ham metin ~5–15k token; GPT'de saniyeler
  beklenir. İnsan planı okurken biter; ölçülecek.
