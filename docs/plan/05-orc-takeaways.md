# 05 — ORC'den devşirilenler: kabul kanıtı, yapısal sapma, kenar durum listesi

Kaynak: `smithdak/ORC` (Claude Code eklentisi, saf prompt tabanlı orkestratör).
Ajan prompt'ları incelendi; çoğu bizde zaten daha olgun (soru kuralları, triage,
`blockers`, mentor, Zod ile doğrulama). Aşağıdakiler **bizde eksik olan** ve
motorun temel ilkesine (*motor yetenek sunar, profil seçer*) uyan parçalar.

Bu belge **taslaktır**; onaylanınca `01-decisions.md`'ye §38 olarak girer.

## Kapsam dışı (bilerek)

| ORC'de ne | Neden almıyoruz |
|---|---|
| Anti-slop, innovation skoru, design-system kapıları | Proje tercihi. Gerekirse profile alan; motora girmez |
| Validator'ın testi/lint'i kendisi koşması | Kural: test agent'ın işi değil, ölçümü orkestratör yapar |
| Piramit yüzdeleri, %80 kapsam hedefi | Proje tercihi |
| Epic düzeyi tutarlılık incelemesi | Review bizde dış süreç (CodeRabbit) |
| Security/DevOps uzman rollerinin ansiklopedik listeleri | Bizim devops'umuz göreve özel ve daha iyi |
| Embedding + güven-bozunumu ile desen eşleme | Karmaşıklık/kazanç oranı kötü |
| **Learner rolü** | Yeni rol + onay kapısı getirir; ayrı karar belgesi ister (bkz. "Sonraya") |

## PR 1 — Yalnız prompt (kod yok, en ucuz)

`agents/core/` altında:

1. **`qa.md` (Görev 1) ve `tester.md`:** dile bağımsız kenar durum kontrol listesi.
   - Girdi: boş, null, yalnız boşluk, azami uzunluk, Unicode.
   - Sınır: tam sınır, bir altı, bir üstü, sıfır, negatif.
   - Durum geçişi: mükerrer, bulunamadı, zaten işlenmiş, bayat veri, eşzamanlı değişiklik.
   - Hata: zaman aşımı, dış servis yok, yetki yok.
   - "Değişen davranışla ilgili olmayan kategoriyi atla" ibaresiyle; liste kapsam şişirmesin.
2. **`planner.md`:** "Teslim etmeden önce" öz denetimi — her safhada `acceptance`
   var, dosya yolları gerçek, safha derlenemeyen ara durum bırakmıyor, aynı
   dosyaya dokunan safhalar sıralı, `exceedsFileCap` varsa gerekçe yazılı.
3. **`developer.md`:** geri bildirimle yeniden denemede "işi bölebilirsin,
   **asla özellik ekleme**" cümlesi.

Risk: yok (prompt metni). Doğrulama: `npm run build` (prompt'lar kopyalanıyorsa).

## PR 2 — Kabul ölçütüne kanıt (`acceptanceEvidence`)

**Sorun.** Planner safhaya 2-4 `acceptance` yazar, insan safhayı onlara bakarak
onaylar. Ama Developer'ın handoff'unda bu maddelerle eşleşen alan yok; insan
"bitti mi"yi diff'ten kendisi çıkarır.

**Tasarım.**

- `HandoffSchema`'ya (`packages/shared/src/job.ts`):
  ```ts
  acceptanceEvidence: z.array(z.object({
    index: z.number().int().min(0),      // safhanın acceptance dizisindeki sıra
    criterion: z.string().default(""),
    met: z.enum(["yes", "no", "unknown"]).default("unknown"),
    evidence: z.string().default(""),
  })).default([])
  ```
  `.default([])` → eski kapı yükleri (DB'deki JSON) bozulmadan okunur (kural 3).
- **Eşleme `index` ile**, metin ile değil: LLM maddeyi yeniden ifade eder, metin
  eşlemesi kırılgan olur. Developer prompt'u maddeleri **numaralı** alır.
- **Sentez (kural 3, üç katman) — `resolveHandoff` içinde DEĞİL.**
  Keşif sonucu: `resolveHandoff(exec, jobId, phaseId, …)` adındaki `phaseId`
  plan safhası değil, artifact anahtarıdır (`qa-<id>`, `review-1-v2`,
  çakışma çözümü…). Dört çağıranı var, yalnız biri Developer safhası ve
  `acceptance`ı bilmez. Tamamlama **safha çağıranında**, `resolveHandoff`
  döndükten sonra yapılır:
  - aralık dışı / mükerrer `index` atılır (üretici güvenilmez);
  - karşılığı olmayan her madde `met: "unknown"`, `evidence: ""`,
    `synthesized: true` satırıyla eklenir (satır bazında bayrak → şemaya
    `synthesized: z.boolean().default(false)` girer);
  - `criterion` metni agent'tan değil plandan yazılır (yeniden ifade
    edilmiş maddeyi insan plandakiyle karşılaştıramaz).
  Not: bugünkü sentez hep-ya-hiç — geçerli blok gelirse eksik alanlar şema
  varsayılanlarıyla sessizce `[]` olur, `synthesized` false kalır. Satır
  bayrağı bu boşluğu bu alan için kapatır.
- **Prompt:** Developer safha prompt'u kabul kriterlerini zaten veriyor
  (`engine/job.ts` ~6307) ama `- ` ile, numarasız. Değişiklik: `0.`, `1.` …
  diye numaralandırmak + `developer.md`'de "Her madde için ya kanıt göster
  (dosya/satır/davranış) ya `unknown` yaz; uydurma" kuralı.
- **UI:** `GatePanels.tsx` safha kapısında "Kabul ölçütleri" listesi; `unknown`
  ve `no` satırları vurgulu. `handoff` tipi (satır ~378) elle yazılmış, shared
  şemadan türemiyor — alan eklerken orayı da genişlet.

## PR 3 — Yapısal sapma (`deviations`)

**Sorun.** Plandan sapma `keyDecisions` içinde serbest metin; insan "plandan
nerede ayrıldı" sorusunu satır satır okuyarak cevaplar.

**Tasarım.**

- `HandoffSchema`'ya:
  ```ts
  deviations: z.array(z.object({
    planned: z.string().default(""),
    actual: z.string().default(""),
    reason: z.string().default(""),
    category: z.enum(["library", "pattern", "security", "architecture", "implementation"]).default("implementation"),
    impact: z.enum(["low", "medium", "high"]).default("low"),
  })).default([])
  ```
- **Motor yeteneği:** `security`, `architecture` ya da `impact: high` sapması
  kapıda **kırmızı vurgu** alır (engel değil, vurgu — kapı zaten insanda).
- **Profil alanı (temel ilke):** "kaç sapmadan sonra durup sor" eşiği proje
  tercihidir → `workflow.deviationReviewThreshold?: number` (yoksa kapalı).
  Motora sabit `5` gömülmez.
- Prompt: `developer.md`'de sapma tanımı + kategori sözlüğü. `keyDecisions` kalır
  (sapma olmayan kararlar için).
- UI: kapıda "Sapmalar" bölümü.

Bağımlılık: PR 2 ile aynı şema bölgesine dokunur → PR 2'ye yığılı (`stacked`) açılır.

## PR 4 — Plan dışı dosya denetimi (deterministik)

**Sorun.** Safhanın dosya listesi "sınır" deniyor; Developer dışına çıkarsa
`filesTouched`a yazması isteniyor (kural 1) ama kodla karşılaştıran bir
denetim olup olmadığı belirsiz.

**Tasarım.**

- Karşılaştırma **git diff'ten gelen gerçek dosya listesi** ile `phase.files`
  arasında (agent'ın beyanı değil — kural 3). Fark = "plan dışı dosyalar".
- Motor yeteneği: kapı yüküne `outOfPlanFiles: string[]` ve UI'da uyarı.
- Profil alanı: `workflow.outOfPlanFiles: "warn" | "ask"` (varsayılan `warn`);
  `ask` ise kapı açılmadan önce insana "bunlar plan dışı, devam?" sorulur.
- Yeni dosyalar (planda "nereye konacağı" yazılı) için glob/dizin eşlemesi:
  tam yol eşleşmesi yetmez; planlanan dizin altı kabul — **açık soru 2**.

**Keşif sonucu:** fark bugün hesaplanmıyor. `PhaseGatePayload`
(`engine/job.ts` ~263) yalnız `handoff`, `diff` (stat/patch/untracked) ve
`build` taşıyor. İki tuzak:
- `handoff.filesTouched` **kaynak olarak kullanılamaz**: geçerli blok
  geldiğinde agent'ın beyanıdır; diff'ten yalnız blok yoksa doldurulur.
  Liste `changedFiles(...)` ile ayrıca çıkarılmalı.
- **Diff tabanı:** `diffBase(jobId)` işin tabanıdır; safhalar onayla
  commit'lendiği için taban yanlış seçilirse önceki safhaların dosyaları da
  "plan dışı" görünür. Safha kapısının diff'inin hangi tabana göre alındığı
  doğrulanıp aynı taban kullanılmalı.

## Yan doğrulama (PR değil, okuma)

ORC ilkesi: *eksik kontrol "geçti" görünmemeli.* Orkestratörde atlanan bir
ölçümün (tarayıcı yok, takım koşmadı) sonucunun **"atlandı"** olarak taşındığını,
"geçti"ye düşmediğini kodda doğrula. Bulgu çıkarsa ayrı düzeltme.

## İş bölümü (model)

Ölçüt: yanlış yapılınca **sessizce** yanlış sonuç üreten yer Opus'ta; hatası
derlemede ya da gözle hemen görünen yer Sonnet'te.

| Parça | Kim | Neden |
|---|---|---|
| PR 1 — prompt metinleri | Sonnet | Mekanik; içerik bu belgede hazır |
| PR 2 — şema alanı, `developer.md`, kabul maddelerini numaralandırma, UI listesi | Sonnet | Tip sistemi ve göz yakalar |
| PR 2 — **safha çağıranında tamamlama** (aralık/mükerrer `index`, satır bayrağı, `criterion` plandan) | **Opus** | Yanlış yerde yapılırsa QA/çakışma handoff'larına da sızar; yanlış eşleme "kanıtlı" görünür |
| PR 3 — sapma şeması, prompt, kapı vurgusu | Sonnet | PR 2'nin kalıbını tekrarlar |
| PR 4 — **diff tabanı ve plan dışı hesap** (tam yol / dizin altı eşleme) | **Opus** | Taban yanlışsa önceki safhalar "plan dışı" görünür; insan uyarılara alışır, gerçeği kaçırır |
| PR 4 — kapı yükü alanı + UI uyarısı | Sonnet | Mekanik |
| Yan doğrulama ("atlandı" ≠ "geçti") — okuma ve rapor | Sonnet | Salt okuma; bulgu çıkarsa düzeltmeyi Opus değerlendirir |
| Learner karar metni (`01-decisions.md`) | **Opus** | Tasarım kararı; açık sorular yeni onay kapısı getiriyor |

## Sıra ve bölme

Hafızadaki kural: özellik başına küçük PR, gerekirse yığılı.

```
PR 1 (prompt)  ── bağımsız, hemen
PR 2 (kanıt)   ── main'den
PR 3 (sapma)   ── PR 2 üstüne yığılı
PR 4 (dosya)   ── main'den; keşif sonucuna göre düşebilir
```

Her PR: `npx tsc -b` + `npm run build` ile doğrulanır. **Test koşulmaz** (insan
komutu); yazılacaksa kullanıcı ister. Yazılırsa yakalaması gereken kusurlar:
(a) eski kapı yükünün yeni alanlar olmadan parse edilmesi, (b) eksik kanıtın
`unknown` ile sentezlenmesi, (c) metin değil `index` ile eşleme.

Not: çalışma ağacında başka oturumun değişiklikleri var
(`api/projects.ts`, `sourceSync.ts`, web `ProjectDetail`). Yeni dallar
`main`'den açılır; yalnız kendi hunk'larım commit'lenir.

## Açık sorular

1. ~~Yalnız `acceptanceEvidence` eksik kaldığında handoff `synthesized`
   sayılsın mı?~~ **Kod okununca netleşti:** satır bazında. Bugünkü bayrak
   yalnız blok hiç yoksa yanar; eksik alan sessizce `[]` olur. Bkz. PR 2.
2. Plan dışı dosya için eşleme: tam yol mu, planlanan dizin altı mı? (Öneri:
   var olan dosyada tam yol, yeni dosyada dizin altı.)
3. `deviationReviewThreshold` ve `outOfPlanFiles` profil alanları PR 3/4'te mi
   gelsin, yoksa önce yalnız motor yeteneği (vurgu/uyarı), profil sonra mı?
   (Öneri: önce yalnız vurgu; eşik/kapı gerçek ihtiyaç görülünce.)

## Sonraya (bu plana dahil değil)

> **Karara bağlandı: `01-decisions.md` §39.** Aşağıdaki taslaktan farkı:
> ayrı depo ve onay yok; dersler merge sonrası haritacı tazelemesine biner.

**Learner → kod haritasına aday `pitfall` öneren, onaya bağlı adım.**
Ayrı rol değil. ORC'nin Learner'ı (başarı/anti-pattern/tercih, embedding ile
eşleme, zamana bağlı bozunum) bizde şu hâle indirgenir; kod haritasıyla
(`01-decisions.md` §35) aynı çatıya oturur. Önce karar belgesinde (§38 ya da
ayrı §) tartışılır, bu plandan bağımsız.

**Neden harita.** Haritacı `pitfalls`a yalnız statik okumada görünen gerçeği
yazar; işin içinde çarpılan tuzak (sessiz bozulan derleme, yanlış varsayılan
sözleşme) orada yoktur. Hammadde zaten üretiliyor: handoff `gotchas`,
`blockers`, kırmızı derleme sonrası `<feedback>`, QA'nın bilerek kırmızı
bıraktığı bulgular.

**Haritanın ORC'nin çözemediğini zaten çözmesi.**
- *Bozunum:* ORC'nin ayda %5 formülü keyfi. Bizde künye `sha` taşır; modülün
  dizinine değişiklik düşünce `stale` olur, silinmez, "kodu doğrula" notuyla
  kalır. Öğrenilmiş not da aynı mekanizmaya biner: bağlı olduğu modül
  değişince "doğrula" işaretiyle gelir.
- *Eşleme:* embedding yok. Aday notun modülü, handoff `filesTouched` ile
  modüllerin `paths`inin kesişiminden deterministik bulunur.

**Taslak tasarım (`server/src/codemap/store.ts` okundu).**
1. **Ayrı depo, render'da birleşir.** `writeCodeMap` `map.json`ı bütün olarak
   (tmp + rename) yeniden yazar; notlar ona girerse ilk tazelemede silinir.
   Notlar ayrı dosyada (`<artifactsDir>/codemap/<projectId>/learned.json`),
   modül `id` ile bağlı (haritacının "id sabit kalmalı" kuralı buna dayanır).
   Birleşme noktası `renderModule(m, usedBy)`: notlar ek parametre olarak
   girer, "Tuzaklar"ın yanında "Öğrenilenler" bölümü olur. Modül eşlemesi
   için `inModule(m, path)` zaten var.
2. **Aday → onay → künye.** İş bitiminde (PR kapısında) aday notlar `Zod`
   ile doğrulanır (kural 3), `scrubSecrets`ten geçer (kural 4), insan
   onaylamadan künyeye girmez: yanlış bir "tuzak" notu sonraki bütün işleri
   sessizce yanlış yönlendirir. Notun kaynağı (iş, safha, handoff alanı) ve
   bağlı olduğu `sha` kayıtlı kalır.
3. **Kapsam ayrımı.** Modüle özgü not → harita. Proje geneli kural (build
   sırası, `-c Release` yasağı gibi) → `projects/<slug>` overlay; o yol bu
   plana girmez, elle yazılmaya devam eder.
4. **Prompt'a girmeme ilkesi korunur (§35).** Notlar künyenin içinde; ajan
   modülü açınca okur. `INDEX.md`ye girmez.
5. **Profil.** `agents.codeMap` altında alt anahtar (ör. `learn`), varsayılan
   kapalı; motor yeteneği sunar, profil açar.
6. **Ölçüm.** §35'in `agent-reads` metriği: notlar tekrar eden keşfi
   (ilk 15 çağrı, iş başına token) azaltıyor mu? Azaltmıyorsa özellik
   kapatılır.

**Açık sorular (karar belgesinde cevaplanacak).**
- Aday notu kim çıkarır: handoff alanlarından kuralla mı, kısa bir LLM adımıyla
  mı? (Eğilim: önce kuralla; `gotchas` zaten metin, LLM genellemeye kayar.)
- İş-özgü ile genellenebilir notu kim ayırır? (Eğilim: insan; onay ekranında
  "bu modülde hep geçerli mi?" tek tık.)
- Ret edilen aday tekrar önerilmesin diye ret kaydı tutulacak mı?
- Haritası kapalı projede (`codeMap.enabled` yok) notlar nereye gider?
  (Eğilim: hiçbir yere; özellik harita varlığına bağlı.)
