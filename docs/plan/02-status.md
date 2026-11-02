# Durum

Son güncelleme: 2026-09-13

## Biten

| Katman | Dosya | Ne yapıyor | Test |
|---|---|---|---|
| Sözleşmeler | `packages/shared/src/` | Profil şeması, durum makinesi, WS protokolü, sır maskeleme, marka sabiti | 14 |
| Veritabanı | `packages/server/src/db/` | 18 tablo, kısmi index'le kaynak tahsisi, migration | 9 |
| Durum motoru | `packages/server/src/engine/` | Tek transaction'lı geçişler, döngü sayacı, olay sırası | 9 |
| Sunucu | `packages/server/src/{app,config}.ts`, `ws/` | Fastify + WS hub, replay, backpressure, maskeleme | 6 |
| Tarama | `packages/server/src/analyst/scan.ts` | Workspace mekanik keşfi, bayatlık imzası | 10 |
| Analyst | `packages/server/src/analyst/analyst.ts` | Profil taslağı üretimi, onay kapısı, sürümleme | 9 |
| Kimlik | `packages/server/src/agents/identity.ts` | Havuz, kota devretme, cooldown | — |
| SDK sürücüsü | `packages/server/src/agents/runner.ts` | Agent turu, canlı giriş kanalı, maliyet kaydı | — |
| REST API | `packages/server/src/api/` | Proje bağlama, analiz (202 + yoklama), profil taslak/onay/red, bayatlık, iş açma/iptal | 9 |
| Kaynak kiraları | `packages/server/src/resources/leases.ts` | Tek tahsis otoritesi; kısmi index reddi → `LeaseConflict` | 1 |
| Worktree | `packages/server/src/workspace/worktree.ts` | Bare mirror + RW kilit, `ignoredButNeeded` kopyalama, `neverCopy` üstünlüğü, `sensitiveFiles` silme | 7 |
| Köprü (sunucu) | `packages/server/src/exec/bridge.ts`, `app.ts /bridge` | İş başına token, hello el sıkışması, koşu akışı, kopma → hata | 7 |
| Konteyner | `packages/server/src/exec/docker.ts` | dockerode ile sertleştirilmiş agent konteyneri, idempotent `ensure`, etiketle listeleme | 2 (Docker + imaj varsa) |
| Taşıma | `packages/server/src/agents/transport.ts` | `LocalTransport` (host `query()`) / `ContainerTransport` (köprü); runner ikisini de aynı görür | — |
| Köprü (konteyner) | `packages/bridge/` | Dışarı doğru WS, `run.start` → SDK, olayları ham iletir, yeniden bağlanır | e2e ile |
| Build kapısı | `packages/server/src/build/` | `forbiddenFlags` reddi, `preSteps`, `whenChanged`/`exceptPaths` seçimi, sıra, satır satır maskeli log; host ve konteyner (`docker exec`) yürütücüsü | 8 (+ e2e) |
| İş motoru + Planner | `packages/server/src/engine/job.ts`, `agents/core/planner.md` | Draft → Planning → PlanReview → Developing; worktree hazırlığı, PLAN_JSON ayrıştırma + bir kez dürtme, plan sürümleme + safhalar, onay/red/düzenleme, aynı oturumdan sohbet | 8 |
| Developer (safhalı) | `engine/job.ts`, `engine/runtime.ts`, `agents/core/developer.md` | Safha → konteynerde Developer (canlı kanal) → build kapısı → diff + handoff ile safha kapısı → onayda commit → sonraki safha; kırmızı build `<feedback>` ile geri, döngü tavanı; handoff yoksa diff'ten sentez; son safhadan sonra QACases | 5 |

| Web UI | `packages/web/` | Vite + React 19 + Tailwind 4 + TanStack Query. Projeler (bağla/analiz/profil onayı/bayatlık), işler (aç/liste), iş detayı: pipeline + safhalar + geçişler, canlı akış (delta + replay, `sinceSeq` ile dikişsiz), sohbet ("kes ve gönder"), plan/safha onay kartı (diff + handoff + build). Sunucu `dist/`i aynı origin'den servis eder, SPA fallback | 1 |
| Yerel ön inceleme | `server/src/review/ocr.ts`, `shared/src/localReview.ts` | PR'dan önce OpenCodeReview iş konteynerinde; bulguları Developer çözer, sonra PR ve bot incelemesi. Protokol/model/anahtar profilde (`workflow.review.local`), anahtar `AHTAPOT_REVIEW_KEYS`'te. Bkz. kararlar §20 | — |
| Operatör ekranı | `web/src/components/{toolView,Stream,PlanReader,QuestionPane}` | Akış zaman çizgisi (araca özel gövde, mini fark, komut kutusu + çıktı + ipucu, 5 filtre), plan okuması (5 bölüm + soru paneli, sonuç/bedel şıkları), kapanabilir sol ray (`localStorage`) | 11 |

| Port havuzu | `packages/server/src/resources/ports.ts` | Kira + gerçek `bind` denemesi (WinNAT hariç aralıkları), hepsi ya da hiçbiri | 5 |
| Açılış uzlaştırması | `packages/server/src/engine/reconcile.ts` | Yarıda kalan işler → NeedsAttention, bitmiş kiralar serbest, yetim konteynerler kaldırılır | 3 |
| Canlı ortam | `packages/server/src/live/` | Compose override (portlar havuzdan, `emptyEnv` tek boşluk, internal + edge ağı), hazırlık ölçütü (HTTP **ve** log deseni, son eşleşme), orkestratör (`compose up`, TTL, uzatma, `down -v`) | 11 (+ Docker e2e) |
| LiveTest kapısı | `engine/job.ts` | Son safha → Building → LiveTest (ortam kalkar, `live_test` kapısı, "Uygulamayı aç"); onay → QACases; red → düzeltme safhası + Developer, `maxLoops.live`; hazır değilse NeedsAttention (ortam yıkılmaz); işe özel ortam değişkenleri (`jobs.live_env`, profili ve orkestratörü ezer; kapıda "Kaydet ve yeniden kaldır", `live_not_ready`de LiveTest'e yeniden açma); probe ağında ad çözülmezse Docker'a sorulup neden söylenir, yapılandırma hatasında beklenmeden düşülür | 3 |

| Test kapısı | `packages/server/src/build/tests.ts` | Takımlar tek koşu, **baseline orkestratörde** (`git stash`), önceden kırıklar ayrı; trx/junit/exitcode ayrıştırma; servisler üst düzey `services` kataloğundan adla, `cloneDb` ile koşu başına şablondan taze klon (§37); servis/klon isteyen takım canlı ortamla aynı `appEnv`i alır, klon dizesi `$dbCloneConnectionString` ile (§38); kurulamayan takım kırmızı (`setupError`), atlanmaz | 4 |
| QA rolü | `engine/job.ts`, `agents/core/qa.md` | QACases: salt okunur tur → `QA_CASES_JSON` → kapı (insan dahil et/çıkar/ekle; `caseApproval:false` ise atlanır) → QA testleri yazar (konteyner, yeni oturum) → baseline + koşu → yeşil: `pr_open` kapısı → onay Done; kırmızı: "Test düzeltmesi N" safhası, `maxLoops.qa`; düzeltme dönüşünde liste yeniden sorulmaz | 2 |

| PR + CI | `packages/server/src/git/github.ts`, `engine/job.ts` | PRReview onayı (`git.pr.openApproval`) → QA testleri commit → uzak `main` merge (`workflow.syncBaseBeforePr`; çakışmayı DevOps çözer, çözüm derlenir; bkz. karar §32) → gerçek remote'a push (mirror'a değil) → `gh pr create` → `pull_requests` → `review.provider` varsa bot beklenir, yorumları Developer turlarla çözer (`maxRounds`, tavanda `review_round` kapısı; bkz. karar §19) → CIWatch (check yoklama) → yeşil Done / zaman aşımı; merge YOK; sağlayıcı `none` ise PR açılmaz | 3 |
| DevOps | `agents/core/devops.md`, `engine/job.ts` | CI kırmızı → kırmızı check'lerin `--log-failed` logu → DevOps (sonnet, iterasyon başına yeni oturum, `gh pr merge`/`git push` yasak) düzeltir → `ci:` commit + push → yeniden izleme; `maxIterations` sonra NeedsAttention | 1 |

| Yeniden açma | `engine/job.ts` `reopen()`, `POST /api/jobs/:id/reopen`, UI "Yeniden aç…" | Done/NeedsAttention işi insanın seçtiği adımdan (Planning, Developing, LiveTest, QACases, QA, PRReview) aynı dal ve worktree ile sürdürür; `retry`in aksine kurtarma noktasını insan seçer. Developing yorum ister (düzeltme safhası olur), PRReview son PR kapısının yüküyle açılır | 1 |

| Agent sorusu | `agents/askUser.ts`, `bridge/main.ts`, `engine/job.ts` | `ask_user` MCP aracı (host'ta süreç içi sunucu, konteynerde köprü üzerinden `bridge.question`/`run.answer`); promise tur boyunca bekler; `agent.question` olayı + `question`/`answer` mesajları; WS `question.answer`, REST `/answer`; `askTimeoutMinutes` dolunca "varsayımınla devam et"; UI'da seçenek düğmeleri/serbest cevap | 2 |

| Profil doğrulama | `packages/server/src/analyst/validate.ts` | `project validate`: repo yolları/dallar/remote, `ignoredButNeeded` varlığı, yasak bayraklar, adım dizinleri, koşulsuz build uyarısı, servisli takımda ön adım, rapor yolu, compose dosyası + uygulama servisi, readiness/emptyEnv uyarıları, imaj varlığı (Docker), port aralığı, neverCopy/sensitiveFiles; `POST /api/profiles/:id/validate`; kaydedilmemiş taslak için `POST /api/projects/:id/profiles/validate` (sürüm doğurmaz, şema hatası satır olarak döner), UI "Doğrula" | 3 |

| Golden DB | `packages/server/src/live/golden.ts` | Bir kez kur (migration + seed **ayrı** adım), iş başına konteyner içi `cp -a` ile klonla; bayatlık (`goldenMaxAgeDays`), yarım golden bırakmaz, iş volume'ü temizlenir | 2 (gerçek Postgres) |

**Toplam 161 test** (shared 14 + server 141 + web 6), hepsi geçiyor. Konteyner e2e testi
Docker ve `ahtapot/agent-base:latest` imajı yoksa atlanır.

### Testlerin yakaladığı gerçek kusurlar

1. JSON sütunlarında `.default("{}")` ham SQL dizesi yazıyordu, okurken nesneye
   çözülmüyordu → `$type` + `$defaultFn`.
2. `Omit` doğrudan bir discriminated union'a uygulandığında birleşim dağılmıyor,
   tipe özel alanlar kayboluyordu → koşullu tip ile dağıtım.
3. `uuid` paketi `v7` adıyla export ediyor, `uuidv7` değil.
4. Sürücü fırlatınca (kimlik yok, SDK çöktü) analiz satırı sonsuza dek
   `running` kalıyordu → `analyze()` içinde yakalanıp `failed` yazılıyor; açılışta
   `reconcileInterruptedAnalyses` yarım kalanları kapatıyor.
5. Profil onayı projenin **tüm** sürümlerini superseded yapıyordu — bekleyen
   başka bir taslağı ve reddedilmişleri de. Artık yalnız önceki `approved`
   sürüm superseded olur ve yalnız `draft` onaylanabilir.

### Ölçülen ortam gerçekleri (2026-09-13)

- Docker Desktop (WSL2, Engine 29.6): konteyner `host.docker.internal` ile
  host'ta **127.0.0.1'e bağlı** porta ulaşıyor — sunucu dışarı açılmadan köprü
  çalışır. Linux sunucuda bu ad `host-gateway` ile çözülür ama sunucunun o
  arayüzü dinlemesi gerekir (`AHTAPOT_BRIDGE_HOST`).
- Windows yolu bind-mount'a **ileri eğik çizgiyle** gider; `E:\x` reddediliyor
  (`toDockerPath`).
- Agent SDK 0.3.270 CLI'yı platforma özel opsiyonel paketlerde taşıyor
  (`claude-agent-sdk-linux-x64`): imaj Linux içinde `npm ci` ile kurulmalı,
  host `node_modules` mount edilemez. Taban imaj 942 MB.
- Sahte anahtarla konteyner koşusu ~3 dk sürüyor (SDK yeniden denemeleri);
  e2e test bu yüzden yavaş, gerçek anahtarla ölçülmedi.

### Giriş (token → TOTP) ve telefon bildirimi

Bkz. `01-decisions.md` §15. `auth/` (oturum, TOTP), `api/auth.ts`,
`notify/notifier.ts`, web `components/Auth.tsx` + `push.ts` + `public/sw.js`.
Giriş ekranı kabuğun dışında (`AuthGate`): token → (bağlıysa) 6 haneli kod.
Üst şeritte "2FA" düğmesi: TOTP bağla/kaldır (QR), cihazda bildirimi aç, deneme
bildirimi, oturumu kapat. **Elle doğrulandı** (geçici DB'li sunucu + curl):
statik `/` 200, token → bekleyen oturum 401, kod → 200, aynı kod ikinci kez
reddedildi, TOTP bağlıyken Bearer reddedildi, WS çerezsiz/yabancı Origin'le
reddedildi; bildirim tetikleri, tekrar bastırma, maskeleme ve ntfy yükü sahte
kanalla. **Gerçek telefonda Web Push denenmedi** (bu ortamda cihaz yok);
testler yazılmadı/koşturulmadı.

### Issue senkronu (GitHub)

Bkz. `01-decisions.md` "Issue senkronu". `tracker/` (adaptör, senkron, aşama
tablosu, süre), `api/badge.ts`, `GitHubClient`'a issue yazan metotlar,
profilde `tracker`, `jobs.external_url` + `external_sync` (migration 0009), iş
detayında `issue #N ↗`. **Derlendi; gerçek bir issue üzerinde denenmedi**,
testler yazılmadı/koşturulmadı.

Canlı test kararı etiketle: `tracker.verdictLabels` (varsayılan açık),
`approveLabel` = `ahtapot-test: onay` → QA, `fixLabel` = `ahtapot-test: düzelt`
→ Developing; düzeltme notu kapı açıldıktan sonra yazılan yorumlardan, not yoksa
issue'ya "yorum yazın" düşülür ve beklenir. `TrackerSync.watchVerdicts` bekleyen
`live_test` kapılarını 45 sn'de bir yoklar (webhook yok), kararı
`engine.decide(..., "github-label")` verir. Ahtapot yorumları `SYNC_MARKER` taşır
(aynı `gh` hesabından yazıldığı için yazarla ayrılamıyor). `statusLabels`
varsayılanı kapalıya çekildi — kayıtlı profillerde alan yazılıysa elle kapatılır.
**Derlendi; gerçek bir issue üzerinde denenmedi**, testler yazılmadı/koşturulmadı.

### Agent tabanı sunucudan

Bkz. `01-decisions.md` §18. `exec/agentBase.ts` (parmak izi, taban build'i,
proje imajı tazeliği), `analyst/imageBuild.ts`ta ortak `runDockerBuild`,
`DockerRuntime` yeni konteynerden önce `ensureForJob`, açılışta arka planda
`ensureBase`, profil build'i önce tabanı tazeler; sunucu imajı köprü + tarif
taşır; `docker-agent-base.yml` kalktı. **Derlendi; gerçek Docker'da
denenmedi**, testler yazılmadı/koşturulmadı.

### Issue şablonları

Bkz. `01-decisions.md` §17. `tracker/issueTemplates.ts` (görev + hata formu,
`config.yml`), `GitHubClient.filesPrState`/`openFilesPr` (`gh api` ile dal +
dosya + PR), bağlanınca otomatik öneri, `GET|POST
/api/projects/:id/github/issue-templates`, proje sayfasında "Issue şablonları"
kartı, iş açıklamasında `_No response_` ayıklama. **Derlendi; gerçek bir repoda
denenmedi**, testler yazılmadı/koşturulmadı.

### Profil düzenleme (tasarım: `Workspace Profil.dc.html`)

Bölüm gezgini tasarımdaki gibi; sürüm/slug/ad tek "Kimlik" kartında (slug projeye bağlı, salt-okunur). Derleme bölümü özel editör: sürüklenerek sıralanan adım kartları, glob çipleri, yasak bayrak yazıldığı anda kırmızı + "Bayrağı sil", build zamanı seçimi. Diğer bölümler şema formundan. Şema hatası ve yasak bayrak kaydı engeller; "Doğrula" kaydetmeden sunucuda ölçer. Ham JSON düzenleme var. Derlendi; tarayıcıda denenmedi, test yazılmadı.

### İşler ekranı (tasarım: `İşler.dc.html`)

Proje sayfasındaki "GitHub issue'ları" sekmesi kaldırıldı; işler, TÜM
workspace'lerin issue'ları ve iş açma tek ekranda (`/jobs?ws=&tab=`). Sağ
panelde açma kriterleri (onaylı profil, bayatlık, kimlik havuzu, gh token,
issue'ya bağlı açık iş). Yeni uçlar: `GET /api/github/issues` (bağlı işle),
`/api/system`'e `github.token` + `jobs.running`; `POST /api/jobs` issue başına
tek iş (409) — yalnız `Cancelled` iş issue'yu serbest bırakır, `Done` da tutar
(klon da aynı kural). **Derlendi; tarayıcıda denenmedi**, testler yazılmadı.

### İşe bağlı emsal (karar §16)

İş açma formunda "Emsal" listesi: host mutlak yolları (`jobs.reference_paths`,
migration 0010). Agent konteynerine `/emsal/<son-parça>` altına salt okunur
bağlanır; Planner/triage/Developer promptu konteyner ve host yolunu birlikte
görür. `workspace.nestedRepos` profilden kalktı. **Derlendi; gerçek konteynerle
denenmedi**, test yazılmadı.

### Engel kapısı (`blocked`)

Agent'ın **yetkisi dışında** kalan işi insana taşıyan kapı. `HandoffSchema`'ya
`blockers: [{ what, why, needsRole, refs }]` eklendi; QA/Developer promptları
bu alanı nasıl doldurduklarını anlatıyor.

Neden: QA "onaylı plan dört tabloya Cascade FK şart koşuyordu, üretim kodunda
yok; yazdığım test bu yüzden bilerek kırmızı ve düzeltmesi benim yetkimde değil"
dedi (2026-09-18). Doğru bir teşhisti ama motor onu duyamıyordu — `gotchas`a
sıkışıyor, kırmızı test `addFixPhase` + Developer'a "testler kırmızı" diye
gidiyordu. Developer'ın en kolay yolu testi gevşetmek olurdu ve bulgu silinirdi.

Akış: `blockers` doluysa (kırmızı **ya da** yeşil testte) `blocked` kapısı açılır,
iş durumu değişmeden `waiting`e geçer. Onay → engel `needsRole: "developer"`
olanlar için plana "Engel düzeltmesi" safhası eklenir ve Developer'a engelin
**metni** gider (`renderBlockerFeedback` — "TESTİ DEĞİŞTİRME" başlığıyla);
`human` ise iş `NeedsAttention`. Red → engel yok sayılır, akış normal sürer.

Profil: `workflow.blockedApproval` (varsayılan **açık**). Kapalıyken engel yalnız
`renderTestFeedback`in başına metin olarak girer.

### Canlı test senaryoları (karar §21)

İnsan porttan test ederken "neyi denemeliyim" sorusu cevapsızdı: QA case'leri
ve otomatik testler canlı test ONAYINDAN SONRA geliyor. Plan kapısında ve canlı
test kapısında **"Test senaryoları çıkar"** düğmesi: yeni `tester` rolü (salt
okunur, `agents/core/tester.md`) plan (+ canlıda değişen dosyalar ve ortam
adresi) okuyup `TEST_SCENARIOS_JSON` üretir — başlık, alan, öncelik, ön koşul,
adımlar, beklenen sonuç. `test_scenarios` tablosu (migration 0012), her istek
yeni satır; `GET|POST /api/jobs/:id/test-scenarios` (POST 202, UI `running`
iken 3 sn'de yoklar). İş durumu değişmez; üretim sürerken `busy` (köprü tek koşu
alır → onay ve sohbet "iş koşuyor" ile bekler). Blok yoksa bir kez dürtülür,
yine yoksa satır `failed`, iş NeedsAttention'a DÜŞMEZ. UI'da alana göre gruplu
liste, senaryo başına geçti/kaldı/kararsız işareti ve Markdown kopyala; son hazır
liste QA case turunun prompt'una aday olarak girer. Açılışta `running` kalan
satırlar `failed` yazılır. **Derlendi; gerçek bir işte denenmedi**, testler
yazılmadı/koşturulmadı.

**İşaretler sunucuda** (migration 0014): `PUT /api/jobs/:id/test-scenarios/:rowId/marks/:key`
(`{ state: pass|fail|unsure|null, note }`, yalnız LiveTest). Canlı test
reddinde "kaldı"lar adım/beklenen/notla red yorumuna eklenip Developer'a ve
düzeltme safhasının gerekçesine gider; "kaldı" varsa yorum zorunlu değil.
Taşınanlar ve aynı alandaki "geçti"ler sonraki turda `retest` ("tekrar test
et") görünür; "kararsız" Developer'a gitmez, sıfırlanmaz. **Derlendi; gerçek
bir işte denenmedi**, testler yazılmadı/koşturulmadı.

### Modelle yeniden dene (karar §22)

`jobs.model_tier` (migration 0013) ile iş başına model seviyesi zorlaması.
NeedsAttention kartında "Modelle dene…" (mobil alt çubukta "Model…"), "Yeniden
aç" diyaloğunda ve `review_round` kapısında seçici; her düğmenin altında
profil merdiveninden çözülen model adı yazar. Seviye seçilerek yeniden
denenirse döngü sayaçları sıfırlanır. `POST /api/jobs/:id/retry` ve `/reopen`
isteğe bağlı `modelTier` alır; `POST /api/jobs/:id/model-tier` yalnız
seviyeyi değiştirir. **Derlendi; gerçek bir işte denenmedi**, testler
yazılmadı/koşturulmadı.

### Safha kapısında sıradaki safha ve modeli (karar §25)

Safha kapısı açıkken Plan sekmesinin üstünde "Sıradaki safha" kartı: başlık,
gerekçe, dosyalar, kabul kriterleri ve koşacak Developer modeli (kaynağıyla:
zorlama / safha ölçümü / elle / plan triage / profil rolü). Seçici "yalnız bu
safha" ya da "kalan N safhanın hepsi" kapsamıyla seviye yazar; kapı kapanmaz.
Banner'da "sıradaki N: model · model değiştir →" çipi (en üst seviyede uyarı
tonu). `GET /api/jobs/:id/next-phase`; `POST /api/jobs/:id/phase-tiers` artık
safha kapısında da geçer (yalnız başlamamış safhalar). **Derlendi; gerçek bir
işte denenmedi**, testler yazılmadı/koşturulmadı.

### Düzeltmeler commit'ten önce yerelde doğrulanır (karar §26)

Yerel inceleme, CodeRabbit ve CI düzeltmeleri (`runDevOps`) commit'lenmeden önce
`workflow.verifyFixes`e göre (varsayılan `build-test`) derleme kapısından ve
`runAt: "qa"` takımlarından (baseline ile) geçer. Kırmızı → aynı oturuma geri
bildirim, `limits.maxLoops.build` deneme; hâlâ kırmızıysa düzeltme stash'e alınır
(`ahtapot-red-fix …`), commit/push yok. Yerel incelemede PR düzeltmesiz açılır;
PR incelemesinde `review_round` kapısı açılır. **Derlendi; gerçek bir işte
denenmedi**, testler yazılmadı/koşturulmadı.

### Workspace release: workflow tetikleme + zamanlı yayın (karar §27)

Profilde `release` bölümü (varsayılan kapalı): hedef repodaki `workflow_dispatch`
workflow'u proje sayfasındaki Release kartından elle (patch/minor/major; önce
dry-run planı) ya da takvimle (haftalık/aylık, saat dilimli) tetiklenir. Zamanlı
tur değişiklik yoksa ve dal ucunda CI kırmızı/sürüyorsa atlanır; `auto` bump
conventional commit başlıklarından. Kayıt `project_releases`; (proje, yuva)
tekil, çökme sonrası `unknown`. Duraklatma profilde değil (`projects.release_paused_until`).
DevOps agent'ına `gh workflow run` ve dispatch ucu kapalı. **Derlendi; gerçek bir
repoda denenmedi**, testler yazılmadı/koşturulmadı.

Sürüm görünürlüğü: üst çubukta çalışan Ahtapot sürümü (repo kökündeki
`version.txt` — yayın workflow'u build'den önce yazar, sunucu açılışta okur;
repodaki `dev` yer tutucusunda `git describe`). Proje listesinde ve başlıkta hedef reponun son sürüm tag'i
(release kapalıyken de; 5 dk önbellek, yayın bitince silinir).

### Ahtapot yayını: elle tetikleme + conventional commit (karar §35)

`release.yml` (Actions → release → Run workflow, `main`): sürümü commit
başlıklarından hesaplar, imajı ghcr'ye yayınlar, sonra tag ve Release açar.
`v*` tag'i atmak artık yayın çıkarmaz. `dry_run` yalnız sürümü gösterir.
**actionlint temiz, sürüm betiği yerelde denendi; GitHub'da koşulmadı.**

### Statik analiz yerel incelemede (karar §29)

Profilde `workflow.review.static` (varsayılan kapalı): adımlar (`run`, isteğe bağlı
`fix`, rapor biçimi `sarif`/`dotnet-format`/`msbuild-log`, `minLevel`, `scope`)
iş konteynerinde PR'dan ve OCR'dan önce koşar; her adım ayrı açılıp kapanır.
Kapsamdaki bulgular `runDevOps` ile Developer'a, düzeltme `verifyFix`ten geçer;
otomatik düzelticinin çıktısı ayrı `style` commit'i. Tavan `maxRounds`,
sayaç `loopCounts.static_review`, bütçe `maxFixPushes`. **Derlendi; gerçek bir
işte denenmedi**, testler yazılmadı/koşturulmadı.

### DAST LiveTest'te (karar §30)

Profilde `live.dast` (varsayılan kapalı): tarayıcı adımları (`image`, `run`,
rapor `zap-json`/`junit`/`sarif`) canlı ortam hazır olunca, kapıdan önce iç
ağda koşar; her adım ayrı açılıp kapanır. Özet `live_test` kapısında; reddedilince
eşik üstü bulgular geri bildirime eklenir, `autoFix` açıksa kapı açılmadan
düzeltme safhası. Raporlar `artifacts/<job>/dast-<tur>/`. **Derlendi; gerçek bir
işte denenmedi**, testler yazılmadı/koşturulmadı.

Kapsam (`live.dast.scope`, 2026-10-12): dalın değiştirdiği dosyalardan
`routePattern` ile uçlar çıkarılıp tarayıcıya `TARGET_PATHS` /
`TARGET_PATH_REGEX` / `$OUT/targets.txt` olarak verilir; kapıda "Hedef"
satırı. Northwind profilinde regex ve tarayıcı komutları henüz güncellenmedi.
**Derlendi; gerçek bir işte denenmedi.**

### Tarayıcı testi LiveTest'te (karar §41)

Profilde `live.browserTest` (varsayılan kapalı): DAST'tan sonra, kapıdan önce
`tester` senaryo listesini (yoksa) çıkarır, aynı oturumda Playwright MCP ile
tek koşuda yürütür ve checklist'i `agent` kaynağıyla işaretler; kanıt
görüntüleri `artifacts/<job>/live-<tur>/`. İş konteyneri tur boyunca
uygulamanın edge ağına bağlanır. Agent "kaldı"sı yalnız insan reddinde
Developer'a gider. Açıkken Developer'a kararlı `id` notu eklenir. Taban
imajına Playwright MCP + Chromium girdi (köprü 0.3.0, `browser` yeteneği).
Ayrıntı ve plandan sapmalar: [`06-live-browser-test.md`](06-live-browser-test.md).
**Derlendi; gerçek bir işte denenmedi**, testler yazılmadı.

### Gereksinimler ve ikinci göz (karar §42)

Planner ham iş tanımını alıntılı `R1…` gereksinimlerine çevirir; safha ve
senaryolar `covers` yazar. Plan sekmesinde "Gereksinimler" (karşılanmayan öne
çıkar). Profilde `review.critic.plan` / `.scenarios` (varsayılan kapalı):
yerel incelemenin sağlayıcısındaki model planı ve senaryoları eleştirir
(`review/llm.ts`, üç protokol), "İkinci göz" kartında görünür; işaretlenen
bulgu red gerekçesine girer. Ayrıntı ve sapmalar:
[`07-plan-critic.md`](07-plan-critic.md).
**Derlendi; gerçek bir sağlayıcıyla ve gerçek bir işte denenmedi**, testler
yazılmadı.

### PR öncesi güvenlik kapısı ve MegaLinter (karar §31)

Statik adımlarda `category` (`security` önce, `quality` sonra) ve `image`
(ayrı konteyner, iş volume'ü aynı yolda — MegaLinter için). `securityGate`
açıksa güvenlik bulgusu kalınca ya da araç koşamayınca `security` kapısı
(onay: bir tur daha; red: kalanlarla devam). Retry statik analizi atlamıyor.
**Derlendi; gerçek bir işte denenmedi**, MegaLinter ayarları (env adları,
SARIF yolu, worktree'nin git dizinine erişim) ilk koşuda doğrulanmalı.

### Adım kontrol listesi (karar §34)

`jobs.step_checklist`: PR zincirinde geçen adım (güvenlik, kod kalitesi,
yerel inceleme, bot incelemesi) yeniden denemede koşmaz; akışa "daha önce
tamamlandı" notu düşer. Güvenlik ve inceleme turu kapısında "devam" kararı
kayda geçer. Koşamayan adım kaydedilmez. İş PRReview'dan önceki bir
duruma dönünce liste silinir. **Derlendi; gerçek bir işte denenmedi.**
Sıradaki aday: QA retry'ı (`qa.write`).

### Kaynak senkronunda erişim denetimi (karar §28'e ek)

Fetch'ten önce `.git` yazma izni, `origin` ve `ls-remote` ile okuma
yetkisi denenir. Uyarı nerede koştuğunu (host, dizin, `whoami`) ve git
stderr'inden sınıflandırılmış nedeni (SSH anahtarı, known_hosts,
`safe.directory`, HTTPS kimliği, ağ) yazar. **Derlendi; gerçek
sunucuda denenmedi.**

### Okuma ölçümü ve kod haritası (karar §35)

- `GET /api/projects/:id/agent-reads?role=planner&jobs=20`: rolün son
  işlerde okuduğu dosyalar, ilk 15 çağrıdaki yönlenme okumaları, tekrar payı,
  iş başına token. `agent.tool_result.chars` 2026-10-12'den sonra dolu.
- `codemap/`: `cartographer` rolü haritayı host'ta üretir, `<artifactsDir>/
  codemap/<projectId>/`e yazar, konteynere `/codemap` salt okunur bağlanır.
  Prompt'a tek satır girer, o da INDEX konteynerde varsa. Kaynak
  senkronundan sonra bayat künyeler işaretlenir, arka planda tazelenir.
  `GET|POST /api/projects/:id/codemap`. Profil: `agents.codeMap.enabled`.
- **Derlendi; sahte runner ve gerçek git deposuyla uçtan uca denendi.
  Gerçek bir projede harita üretilmedi.** Sırada: UI'da durum/üret düğmesi,
  ölçümle öncesi/sonrası karşılaştırması.
- Öğrenme (karar §39): merge sonrası işin tuzakları (handoff, kırmızı build,
  insan reddi) tazelemeye ders olarak gider, haritacı dokunulan künyelerin
  `pitfalls`ına işler. Profil: `agents.codeMap.learn`. **Derlendi; gerçek
  bir merge'de denenmedi.**

### Kod grafiği — Trail (karar §44, deney)

- Profil `agents.codeGraph.enabled` (varsayılan kapalı). Açıkken motor
  Planner/Developer/QA koşusundan önce konteynerde `trail build` koşar
  (grafik worktree dışında), köprü `trail mcp`yi repo başına MCP sunucusu
  olarak ekler (`codegraph` yeteneği), prompt'a araç notu girer.
- Taban imaj `@trailhq/trail-code@0.23.1` kurar; köprü 0.4.0.
- `agent-reads`: `totals.graphCalls`, iş başına `graphCalls`.
- **Derlendi. Trail CLI ve MCP sandbox'ta elle denendi (repo temiz kalıyor,
  C# çağrı kenarları basit örnekte doğru). İmaj build edilmedi, gerçek bir
  işte koşmadı.** Sırada: taban imajı tazele, Northwind'de aynı türden işleri
  grafikli/grafiksiz koş, `agent-reads` ile karşılaştır.

### Gerçek Northwind üzerinde doğrulanan

`scan.test.ts` içindeki son test yerelde bir Northwind workspace'i varsa koşuyor ve şunları
bağımsız doğruluyor: `Northwind.Forms` nested repo (submodule değil), `.run/`
gitignore'lu ama diskte, `CLAUDE.md` 476 KB (oversized), `Northwind.slnx` solution,
`main` dalı.

## Sırada

### Mentor (karar §33)

- [x] **1. Gözlem.** `agents/stuck.ts`: saf `StuckDetector`
      (`repeat_read`, `repeat_failure`, `no_progress`). Runner araç
      çağrılarını ve sonuçlarını besler; motor `stuckPolicy` ile profilden
      karar verir (`app.ts`'te bağlanır). `agent.stuck` WS olayı kayıtlı
      kalır, eşik ölçümü bu kayıtlarla yapılacak. Akışta "döngü şüphesi"
      satırı Kapılar grubunda görünür. Profilde `agents.mentor` var
      (`enabled:false`, `mode:"observe"`, `consult` henüz `observe` gibi
      davranıyor). Bir sinyal eşikte ve sonra eşiğin her katında yeniden
      düşer. **Derlendi; gerçek bir işte denenmedi, testi yok.** Kabukla
      okuma (`cat`, `sed -n`) henüz `repeat_read` sayılmıyor.
- [ ] **2. Ölçüm.** Northwind'de preview ve CI oturumlarında açılır, eşikler
      yanlış pozitife göre ayarlanır. `consult` buradan önce açılmaz.
- [x] **3. Danışma hattı.** Seviyeden mentor basamağının çözülmesi, `exec/`
      ile soru dosyasının derlenmesi (`scrubSecrets`), host'ta araçsız mentor
      koşusu, `agent.mentor` olayı ve `role:"mentor"` maliyeti. Soru dosyasını
      `exec/` değil runner derliyor: tekrar okunan dosyanın içeriği zaten son
      araç sonucunda. `agents/mentor.ts` (basamak, soru dosyası, öneri
      sarmalı), `agents/core/mentor.md`, `JobEngine.consultMentor`.
- [x] **4. Teslim.** Köprüye `run.hold`/`run.guide`, `PreToolUse` bekletme ve
      ek bağlam, `bridge.hello`da `capabilities`, aynı kanca
      `LocalTransport`ta. Gözcü bekleme süresini sessizlik saymaz.
      `PreToolUse.additionalContext` SDK 0.3.295'te var. Köprü sürümü 0.2.0;
      yeni imaj gerekiyor, eski konteynerde danışma "atlandı" olarak düşer.
- [x] **5. UI.** Akışta danışma kartı (sinyal, junior → mentor, cevap, maliyet).
      Profil ekranında `agents.mentor` alanları.

**Derlendi; gerçek bir işte denenmedi, testi yok.** Adım 2 (ölçüm) insanın:
önce `observe` ile eşikler ayarlanır, sonra `mode: consult`.

### Faz 1 — kalan

- [ ] **Analyst'i gerçek SDK ile koştur.** Şu an sahte runner ile test ediliyor;
      gerçek bir tur Northwind profilini üretmeli. `CLAUDE_CODE_OAUTH_TOKEN`
      gerekiyor (abonelik token'ı: `claude setup-token`). **Engelli:** bu
      makinede ne ortam değişkeni ne `data/keys.txt` var (2026-09-13). Token
      gelince: `POST /api/projects` (Northwind) → `POST /api/projects/:id/analyze`
      → `GET /api/analyses/:id` ile sonuç.
- [x] **REST API.** Proje bağlama, analiz başlatma, profil onayı, iş açma.
- [x] **`project validate`.** Onaydan önce mekanik denetim; hata onayı
      engellemez ama UI'da görünür (`analyst/validate.ts`).
      Uçlar aşağıda. Planning'e geçiş (`Draft → Planning`) Planner ile gelecek.
- [x] **Agent konteyneri + WS köprüsü.** `packages/bridge`, `docker/agent/Dockerfile`,
      `exec/docker.ts`. Uçtan uca doğrulandı: konteyner kalkıyor, köprü
      `host.docker.internal` üzerinden 127.0.0.1'e bağlı sunucuya ulaşıyor,
      sahte anahtarla SDK hatası runner'a dönüyor, sır DB'ye sızmıyor.
      Kalan: `reconcile()` ile yetim konteyner temizliği (Faz 4), egress
      allowlist (Linux, R3).
- [x] **Worktree yöneticisi.** Mirror + kilit, kopyalama/koruma/silme. Kaynak
      workspace'e dokunulmuyor. Kalan: çok-repo `repoGlobs` (Faz 5, Contoso).
- [x] **Build kapısı.** `BuildGate.run()`: yasak bayrak varsa hiçbir komut
      koşmaz; ön adımlar → seçilen adımlar profil sırasıyla; kırmızı adımda
      durur (`failureIsBlocking`), `optional` düşse de yeşil; değişiklik
      **bilinmiyorsa** hepsi koşar, **boşsa** koşullu adımlar atlanır. Northwind
      kabul testleri #1 (`-c Release` reddi) ve #3 (sıra) burada. Komutlar işin
      konteynerinde `docker exec` ile koşuyor (`ContainerExecutor`), e2e'de
      doğrulandı. Kalan: baseline ölçümü ve test takımları (Faz 3), agent'a
      araç sonucu olarak verme (Planner/Developer ile).
- [x] **Planner + plan onay kapısı.** `JobEngine.start()` worktree'yi hazırlar,
      Planner'ı salt okunur koşturur (`Read/Glob/Grep`), `PLAN_JSON`'ı Zod'dan
      geçirir (blok yoksa bir kez aynı oturumdan ister, yine yoksa
      NeedsAttention), planı sürümler, safhaları ayrı satırlara yazar, kapı
      açar. Red + yorum → Planning, Planner **aynı oturumdan** günceller.
      Onay + `edits` → insanın planı doğrulanıp onaylı sürüm olur. Dosya
      tavanı orkestratörce ölçülür. Sohbet: PlanReview'da Planner cevaplar;
      canlı koşuda kanala düşer. Uçlar: `POST /api/jobs/:id/start` (202),
      `GET /api/jobs/:id/plan`, `POST /api/approvals/:id/decide`,
      `POST /api/jobs/:id/chat`; WS `chat.send` / `approval.decide` /
      `job.interrupt` motora bağlı.
- [x] **Developer rolü (safhalı).** Plan onayı → `runDeveloping`: sıradaki
      safha, `DeveloperRuntime.acquire` (Docker: konteyner + köprü + `docker
      exec`; test: host), Developer canlı kanalla koşar (`bypassPermissions`,
      git commit/push/checkout/clean/reset yasak), tur sonunda HANDOFF_JSON
      varsa kanal kapanır, yoksa `askTimeoutMinutes` sonra bir kez dürtülür.
      Orkestratör derler (Building), kırmızıysa log kuyruğuyla `<feedback>` ve
      `maxLoops.build` tavanı; yeşilse safha `awaiting_approval`, kapı yükü
      diff (stat+patch+untracked, maskeli) + handoff + build sonuçları. Onay →
      worktree'de commit (`commitTemplate`, marka botu) → sonraki safha; red →
      aynı safha, aynı oturum, yorumla. Son safha → Building → QACases.
      **Gerçek SDK ile henüz koşmadı** (token yok); akış sahte Developer +
      host yürütücüyle 5 testte doğrulandı.
- [x] **QA rolü.** Bkz. tablo. Uçtan uca (sahte agent'larla) Draft → … →
      PRReview → Done yürüyor. Kalan: PR açma (`gh`), DevOps/CI izleme,
      servis isteyen test takımları (dış servis + şablon klonu §37, konteyner servisi koşu başına ağda §38), test dizini dışına yazma
      DENY (SDK hook'u).
- [x] **Web UI (ilk sürüm).** `packages/web`. Üç sütunlu iş detayı: sol
      pipeline/safhalar/geçişler, orta sohbet + build logu sekmeleri (delta
      akışı, replay), sağ bekleyen kapı (plan: özet + safhalar; safha: handoff
      + build + diff). Token `localStorage`'da, `Authorization` başlığıyla.
      Geliştirme: `npm run dev -w @ahtapot/web` (5180, API/WS proxy).
      Üretim: `npm run build` → sunucu `packages/web/dist`i servis eder.
      **Tarayıcıda elle doğrulanmadı** (bu oturumda tarayıcı yok); tip
      denetimi, üretim derlemesi ve SPA/404 testi geçti. Kalan: plan
      düzenleme (edits) formu, maliyet sayfası, sanallaştırılmış uzun akış.
- [x] **Windows I/O ölçümü (R1).** Ölçüldü (bkz. `01-decisions.md` §11):
      named volume tam build'de 2×, artımlıda 5× hızlı (272 → 135 s, 90 → 19 s).
      Öneri: worktree named volume'de, git konteynerde. **Karar insanı
      bekliyor**; onaylanırsa WorktreeManager ve safha diff/commit'i konteyner
      tarafına taşınır (Faz 2 başı).
- [x] **Worktree'yi named volume'e taşı.** Yapıldı 2026-09-17; bkz.
      [`03-worktree-volume.md`](03-worktree-volume.md). Worktree + mirror named
      volume'de, git/kopyalama/commit/diff/push konteynerde (`CommandExecutor`),
      kaynak workspace salt okunur `/source` mount'u. Planner ve QA case turu da
      konteynere taşındı (host'ta koşan son rollerdi). Tetikleyen ölçüm: Northwind
      web build'i **30 dakikaya** çıkmıştı — NTFS → WSL2 (9p) → konteyner
      zinciri. **Derleniyor; testler koşturulmadı, gerçek işle ÖLÇÜLMEDİ.**

### Faz 3 — biten

- [x] Test kapısı: baseline `git stash` ile orkestratörde, önceden kırıklar
      `preexistingFailures`; profil `test.suites[].report` (trx / junit /
      exitcode) eklendi.
- [x] QA case akışı + QA test yazımı + PRReview kapısı; UI'da case düzenleyici
      ve sonuç kartı.
- [x] Draft PR açma + CI izleme (`GitHubClient` arayüzü; `gh` CLI uygulaması,
      testler sahte). Merge arayüzde yok. **Gerçek `gh` ile henüz koşmadı.**
- [x] DevOps rolü: CI kırmızısında log ile düzeltme, tavanlı. Northwind'de
      `review.autoTrigger:false` — CodeRabbit tetiklenmez; DevOps yalnız CI'a bakar.

**Faz 3 uçtan uca (sahte agent'larla) tamam.** Gerçek SDK/`gh` ile koşmadı.

### Canlı etkileşim — biten

- [x] Sohbet (tur sınırında / kes ve gönder), onay kapıları, canlı ortam uzatma.
- [x] Agent sorusu: `ask_user` MCP aracı her rolde (Planner, Developer, QA,
      DevOps); cevap gelene kadar tur askıda, zaman aşımında varsayımla devam.
      **Gerçek SDK ile MCP aracının çağrıldığı doğrulanmadı** (token yok).

### Faz 2 — biten

- [x] Port havuzu + kaynak kiraları (gerçek bağlanabilirlik kontrolü).
- [x] Compose override üretici, hazırlık ölçütü, canlı ortam orkestratörü
      (compose CLI v2; **ölçüldü:** `internal` ağda yayınlanan port host'tan
      erişilemez → app ayrıca edge ağına bağlanır).
- [x] LiveTest kapısı motorda: onay → QACases; red + yorum → "Canlı test
      düzeltmesi N" safhası açılır, Developer safha bağlamı + yorumla koşar,
      onaydan sonra ortam yeniden kalkar; `live.extend` WS/REST; UI kartı.
- [x] Golden DB: migration + seed ayrı adım, named volume klonu (konteyner içi
      `cp -a`, host FS devreye girmez). Gerçek Postgres ile doğrulandı: klon
      tohumu taşıyor, klondaki değişiklik golden'a sızmıyor. `LiveEnvironments`
      bağlı: ortam kalkarken golden hazırlanıp klonlanıyor, klon DB servisine
      bağlanıyor (golden'ın kendisi DEĞİL), yıkımda klon siliniyor.
- [ ] Ters proxy (`access: proxy`), `PathBase` sorusu (R4/R5 ile birlikte).
- [ ] Çoklu repo worktree (`repoGlobs`, Contoso — Faz 5).

### Faz 2-5

Bkz. [`00-master-plan.md`](00-master-plan.md) §13.

## REST uçları

Tümü oturum çerezi ister (bkz. `01-decisions.md` §15); TOTP bağlı değilken
`Authorization: Bearer <AHTAPOT_ADMIN_TOKEN>` de geçer. `/health`, statik UI ve
giriş uçları serbest. Hata zarfı her yerde `{ error, issues? }`.

| Uç | Ne |
|---|---|
| `GET /api/auth/status` | `{ authenticated, next: "token"\|"totp"\|null, tokenConfigured, totpEnabled, open }` |
| `POST /api/auth/login` | `{ token }` → çerez; TOTP bağlıysa `next:"totp"` (5 dk'lık bekleyen oturum) |
| `POST /api/auth/totp` | `{ code }` → tam oturum |
| `POST /api/auth/logout` | Oturumu siler |
| `POST /api/auth/totp/setup` · `/confirm` · `/disable` | QR + sır · kodla bağla (diğer oturumlar kapanır) · kodla kaldır |
| `GET /api/push` · `POST /api/push/subscribe` · `/unsubscribe` · `/test` | VAPID anahtarı + cihaz sayısı · abonelik · deneme bildirimi |

| Uç | Ne |
|---|---|
| `GET /api/system` | Marka, kimlik havuzu durumu (anahtar değeri asla dönmez) |
| `GET/POST /api/projects` | Liste · bağla (`slug`, `name`, `workspaceRoot` — dizin var olmalı) |
| `GET /api/projects/:id` | Detay + aktif profil + son analiz + süren analiz |
| `GET /api/projects/:id/drift` | Onaylı profil bayat mı (workspace'i yeniden tarar; elle yazılmış profilde `known:false`) |
| `POST /api/projects/:id/analyze` | Analyst'i başlatır → **202** `{ analysisId }`; proje başına tek analiz (409) |
| `GET /api/projects/:id/analyses` · `GET /api/analyses/:id` | Analiz durumu; bitince bağlı taslak profil |
| `GET /api/projects/:id/profiles` | Sürüm listesi (belge hariç) |
| `POST /api/projects/:id/profiles` | Elle yazılmış/düzeltilmiş taslak; aynı Zod şemasından geçer |
| `GET /api/profiles/:id` | Tam belge + gerekçe |
| `POST /api/profiles/:id/decision` | `approve` / `reject` — yalnız taslak; onay öncekini superseded yapar |
| `GET/POST /api/jobs` | Liste (`projectId`, `state`, `limit`) · aç — **onaylı profil şart (409)**, iş o sürümü taşır; aynı `externalRef` için açık iş varsa 409 |
| `GET /api/jobs/:id` | İş + geçiş izi |
| `GET\|POST /api/projects/:id/github/issue-templates` | Issue şablonlarının repodaki durumu / eksikler için PR |
| `GET /api/projects/versions` | Tüm projelerin son sürüm tag'i `{ [id]: { repo, tag, version } \| null }` (5 dk önbellek) |
| `GET /api/projects/:id/release` | Release ayarı, duraklatma, sonraki zamanlı tur, uçuştaki yayın (tembel yenilenir), son 20 kayıt |
| `POST /api/projects/:id/release` | `{ bump }` → workflow'u elle tetikler → **202** `{ releaseId }`; süren yayın varsa / profilde kapalıysa 409 |
| `POST /api/projects/:id/release/dry-run` | `{ bump? }` — hiçbir şey yazmadan plan (sürüm, dal, girdiler, commit/CI, atlama nedeni) + workflow dosyası uyarıları; `bump` yoksa zamanlı tur |
| `POST /api/projects/:id/release/pause` | `{ until: ISO \| null }` — zamanlı yayını duraklat/sürdür (profil onayı istemez) |
| `GET /api/github/issues` | Tüm workspace'lerin açık issue'ları + bağlı iş; proje başına hata ayrı |
| `GET /badge/jobs/:id.svg` | **Kimliksiz** durum rozeti (issue yorumları için) |
| `POST /api/jobs/:id/cancel` | `transition()` üzerinden Cancelled; bitmiş işte 409 |
| `GET /api/jobs/:id/next-phase` | `{ next }` — safha kapısında sıradaki (başlamamış ilk) safha + koşacağı Developer modeli; yoksa `null` |
| `POST /api/jobs/:id/model-tier` | `{ tier }` — işe model seviyesi zorla / `null` kaldır; basamak merdivende yoksa 400 |
| `GET\|POST /api/jobs/:id/test-scenarios` | Canlı test senaryoları: son istek + geçmiş · iste (`{ note }`) → **202**; yalnız PlanReview/LiveTest, iş koşarken 409 |
| `PUT /api/jobs/:id/test-scenarios/:rowId/marks/:key` | Senaryo işareti (`{ state: pass\|fail\|unsure\|null, note }`); yalnız LiveTest, senaryo başına |

## Nasıl koşturulur

```bash
npm install
npm run build
npm test -w @ahtapot/shared
npm test -w @ahtapot/server
npm run docker:build              # agent taban imajı (köprü + SDK); e2e test bunu ister
npm run dev -w @ahtapot/web       # UI geliştirme (5180 → 7717 proxy)

# Sunucu (varsayılan 127.0.0.1:7717)
npm run dev -w @ahtapot/server

# Şema değişince
npm run db:generate -w @ahtapot/server
```

Yapılandırma: `AHTAPOT_DB`, `AHTAPOT_DATA`, `AHTAPOT_KEYS`, `AHTAPOT_PORT`,
`AHTAPOT_ADMIN_TOKEN`, `AHTAPOT_SESSION_HOURS`, `AHTAPOT_RESET_2FA`,
`AHTAPOT_VAPID_SUBJECT`, `AHTAPOT_NTFY_URL`, `AHTAPOT_NTFY_TOKEN`,
`AHTAPOT_PUBLIC_URL`, `AHTAPOT_LOG_LEVEL`, `AHTAPOT_BRIDGE_HOST`,
`AHTAPOT_AGENT_IMAGE`.

Kimlik havuzu (`AHTAPOT_KEYS`, varsayılan `./data/keys.txt`): satır başına bir
token. `sk-ant-oat…` abonelik, diğerleri Console API anahtarı sayılır. Dosya
yoksa ortam değişkenine düşülür.
