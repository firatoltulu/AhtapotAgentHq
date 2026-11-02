# AhtapotAgent — Çok-Agent Geliştirme Orkestrasyon Sistemi

> **Konum:** yeni, bağımsız repo.
> **İlk hedef proje:** Northwind — sistemin parçası değil, *dışarıdan bağlanan*
> bir workspace. Ad (`AhtapotAgent`) tek bir yerden değiştirilebilir olmalı.

## Context

**Problem.** Geliştirici bir agent'a iş verdiğinde bitmesini bekliyor: tek lokal checkout var,
agent orada çalışırken kendi işine devam edemiyor. Mevcut `AdventureWorks.DevAgent` bunu sunucu
tarafında çözmüş (ClickUp etiketi → kuyruk → izole konteyner → draft PR) ama akışı **tek atışlık
ve kör** — iş başladıktan sonra yön verilemiyor — ve ClickUp'a + AdventureWorks'e sıkı bağlı.

**Amaç.** Proje-agnostik, çok-agent'lı, **canlı etkileşimli** bir geliştirme orkestratörü:

```
workspace bağla → Analyst analiz eder → profil onayı
  ↓
iş gir → Planner plan üretir → tartış + onayla
  → Developer geliştirir (safhalı) → build → canlı ortam, porttan test et
  → QA case listesi sunar, onayla → testler → PR onayı → PR
  → DevOps CI'ı takip eder
```

Her aşamada insan agent'la **koşarken** konuşabilir. Geçmiş oturumlar, planlar ve bağlı PR'lar
kalıcı saklanır.

**Yeni ve kritik olan:** Pipeline'dan önce bir **workspace bağlama + proje analizi** aşaması var.
Profil elle yazılan bir YAML değil; **Analyst agent** workspace'i tarayıp taslağı üretir, insan
onaylar. Northwind'in 5000 satırlık CLAUDE.md'si ve 61 KB'lık `run.ps1`'i varken elle profil yazmak
pratik değil.

## Temel prensip

> **Motor yetenek sunar, profil hangisinin geçerli olduğunu söyler.**

Northwind'in ölçülmüş çalışma disiplini (safha onayı, test case'lerini sorma, review'ın dış süreç
olması) motora gömülmez — profile girer. Proje-agnostiklik iddiasını gerçek kılan budur.

## Kararlaştırılanlar

| Konu | Karar |
|---|---|
| Repo | Yeni bağımsız repo, `git init` |
| Hedef proje | Config'ten bağlanır; **Northwind ilk kullanıcı**, sistemin parçası değil |
| Analiz | **Analyst agent çıkarır, insan onaylar**; elle tazeleme + **bayatlık uyarısı** |
| Hedefleme | Planner analizden seçer, insan plan onayında düzeltir |
| Etkileşim | **Canlı sohbet** — streaming input, koşarken mesaj enjeksiyonu |
| SDK yeri | **Konteyner içinde, iş boyunca ayakta kalan kalıcı konteyner** |
| Roller | **Analyst** + Planner / Developer / QA / DevOps |
| Developing | **Profil seçer:** safhalı (Northwind) veya tek blok |
| QA | **Case listesi sunar → insan ekler/çıkarır → testleri yazar** |
| DevOps | Profil belirler; **Northwind'de review auto-trigger kapalı** |
| Canlı test | İlk fazda; iş başına izole DB + port |
| Onay kapıları | Profil · Plan · (Safha) · Canlı test · Test case · PR |
| Paralellik | 5+ iş, kaynak havuzlarıyla |
| Kalıcılık | SQLite (WAL) → PostgreSQL yolu açık |
| Çalışma yeri | Windows (Docker Desktop/WSL2) **ve** Linux sunucu |

## Ortam bulguları (doğrulandı)

- Docker Desktop **WSL2** üzerinde: `overlay2`, kernel 5.15, OSType=linux → konteyner tarafı
  lokalde ve sunucuda aynı.
- **8 CPU / 16 GB RAM** — 5 paralel iş × (uygulama + PG + Redis + ES) bu makineyi aşar.
  Eşzamanlılık kuyruğu ve canlı-ortam tavanı zorunlu.
- Disk: 411 GB boş.
- **Northwind ile Contoso farklı topolojiler** — proje-agnostiklik testi için ideal:
  Northwind **tek repo** (`Northwind.slnx`, .NET 10, Partials+Plugins), Contoso **15+ bağımsız repo**.

---

## 1. Northwind'den çıkan, motoru şekillendiren gerçekler

Bunlar profile girecek ama motorun **desteklemesi gereken yetenekleri** belirliyor:

| Northwind kuralı (CLAUDE.md) | Motor gereksinimi |
|---|---|
| "Her safhadan sonra DUR ve onay iste" (3-4 dosya tavanı) | **Safhalı Developing** modu |
| "Safha sonunda yalnızca DERLEME, test değil" | Kapılar aşama başına ayrı yapılandırılabilir |
| "Testler en son onaydan sonra, TEK KOŞU" | QA aşaması sonda, tek koşu |
| "Test case'leri kullanıcıdan sorulur" | **QA case onay kapısı** |
| "İş tamamlanınca DUR: commit yapma, PR açma" | **PR onay kapısı** (zaten planlıydı) |
| "Code review DIŞ süreçtir, kendiliğinden tetiklenmez" | `review.autoTrigger: false` |
| "DERLEME YALNIZCA DOKUNULAN KATMANDA" (`.tsx` → npm, `.cs` → dotnet) | **Koşullu build** — değişen dosya tipine göre komut seçimi |
| İstisna: kaynak metni okuyan sözleşme testleri | Koşullu build'in istisna listesi |
| "Host çalışırken `dotnet build` DLL kilidine takılır (MSB3027)" | Build öncesi host durdurma adımı |
| "ES dolu ama erişilemezse host açılışta ölür" | Canlı ortamda ES boş bırakılabilmeli |
| "Kurulum (seed) migration'dan AYRI, atlanamaz — tohumsuz DB'de her uç 403" | Golden DB seed komutu ayrı adım |
| `appsettings.json` sır taşır, `.gitignore`'da | `sensitiveFiles` + şablondan üretme |
| Test tabanı: **2305/2305 geçiyor** | Baseline temiz — her kırık agent'ın sorumluluğu |

**Kanonik komutlar (Northwind) — analizle doğrulandı:**

```
ÖN KOŞUL (zorunlu):  cp Northwind.Host/appsettings.json.example Northwind.Host/appsettings.json
                     # yoksa MSB3030 ile build/publish düşer (.gitignore:133)

BUILD SIRASI (bağlayıcı):
  1. npm: Partials|Plugins/*/wwwroot  →  2. npm: Northwind.Web  →  3. dotnet
  # TERS SIRADA publish BAŞARILI olur ama panel sessizce EKRANSIZ açılır
  dotnet restore Northwind.slnx
  dotnet build Northwind.slnx -c Debug --no-restore -v minimal -nologo
  YASAK: -c Release      → private AdventureWorks.* NuGet, secret'sız 401 (kısıt, tercih değil)
  YASAK: -warnaserror    → 1047 devralınmış uyarı

TEST (iki ayrı kapı):
  birim:       dotnet test Northwind.Base.Tests -c Debug --no-build
               → in-memory SQLite, DIŞ BAĞIMLILIK YOK, konteyner dostu
  entegrasyon: Postgres 15 + Redis 7 ister; ES ve Rabbit ' ' (TEK BOŞLUK) olmalı
               ön adım ZORUNLU: dotnet run --project Northwind.Host --no-build -- --install=true ...
               # atlanırsa izin tablosu boş → her uç 403 → BOLA testleri YANLIŞ YÖNDE geçer

AYAĞA KALDIRMA: .\run.ps1  (host 5080, panel 5173)
HAZIR SAYILMA:  GET /api/ping 200  VE  log'da "Registered N endpoints", N>0
                # FastEndpoints DB'ye ulaşamazsa hatayı YUTAR ve sıfır route ile dinler
```

**Portlar:** host 5080 · panel 5173 · postgres **5433** (konteyner `postgresc` — **script
oluşturmaz, yoksa Fail**) · redis 6379 (**zorunlu**) · rabbit 5672 (ops.) · elastic **9209** (ops.)

**CI kapıları:** `build` · **`integration` (hard gate)** · `format` (chore'da atlanır);
`nightly.yml` (sast/dast) PR'ı bloklamaz → DevOps dokunmaz.

### Sistemin en kolay yapacağı 6 hata (analizden — kabul testlerine girer)

1. `-c Release` ile derlemek → private NuGet 401
2. appsettings şablonunu kopyalamamak → MSB3030
3. **.NET'i npm'den önce derlemek → publish başarılı, panel ekransız (SESSİZ)**
4. Host çalışırken `dotnet build` → MSB3021/MSB3027 DLL kilidi
5. `Northwind.Forms/`'u submodule sanmak → `git clean -xfd` commit edilmemiş işi siler
6. **`.run/` içeriğini log/artifact/context'e almak → canlı bearer token sızar + 5 MB log**

---

## 2. Mimari

```
Tarayıcı — Web UI (React + Vite + TS)
    │ REST                    │ WebSocket
┌───▼─────────────────────────▼──────────────────────────────┐
│ ahtapot-server (Node 22 + TS, modüler monolit)             │
│  api/ ws/ engine/ agents/ analyst/ resources/ exec/ db/    │
└───┬────────────────────────────────────────────────────────┘
    │ Docker Engine API (dockerode)
┌───▼────────────────────────────────────────────────────────┐
│ ahtapot-agent-<job>  KALICI: SDK + WS köprüsü (iş boyunca)  │
│ ahtapot-live-<job>   canlı uygulama (+bağımlılıklar)        │
│ ahtapot-db-<job>     izole PostgreSQL (golden klonu)        │
└────────────────────────────────────────────────────────────┘
```

**Modüler monolit:** 5-20 paralel iş / 1 kullanıcı ölçeğinde kritik durum (job state ↔ WS ↔ SDK
akışı ↔ kaynak kirası) aynı bellekte olduğunda canlı etkileşim basit kalır. Sınırlar yine de
katı: `engine/` Docker'ı bilmez, `agents/` durum makinesini bilmez, `resources/` **tek tahsis
otoritesidir**, modüller arası her mesaj Zod şemasıyla tanımlı.

### SDK nerede koşar — kalıcı konteyner

**Karar: SDK konteyner içinde, konteyner iş boyunca ayakta.**

| İtiraz | Kalıcı konteynerde çözümü |
|---|---|
| Streaming input çift yönlü kanal ister | Konteyner içindeki köprü sunucuya **dışarı doğru** WS açar; porta ihtiyaç yok |
| Transcript kalıcılığı (`resume`) | Transcript worktree/`.ahtapot/` altında — bind-mount'ta kalıcı |
| Kimlik devretme konteyneri öldürür | **Öldürmez:** kimlik `query()` başına `options.env` ile; kota → aynı konteyner, `resume` |
| İki atlama gecikmesi | Köprü delta'ları 50ms pencerelerde toplar |

Kazanç: DevAgent'ın güvenlik sınırı **aynen korunur** (`--cap-drop ALL`, egress allowlist,
docker.sock yok). Host'ta koşsaydı güvenlik tek bir `PreToolUse` yol-kontrolüne inerdi.
Bedeli: konteyner içinde ~200 satırlık köprü. Kabul edilmiş takas.

> **Kimlik yalıtımı:** konteyner **daima tek anahtar görür**. Havuz dosyası mount edilmez,
> `--env-file` ile geçmez (DevAgent'ın en pahalı derslerinden biri).

**Teknoloji:** TypeScript/Node 22 · Fastify + `@fastify/websocket` · **Zod** (tek şema kaynağı) ·
**Drizzle** + drizzle-kit · SQLite(WAL)→PG · React 19 + Vite + Tailwind + shadcn/ui · TanStack
Query + Zustand · **dockerode**.

---

## 3. Aşama 0 — Workspace bağlama ve proje analizi

Pipeline'dan önce gelir; **çıktısı onaylı bir profildir.**

```
Workspace bağla (yol) → Analyst tarar → profil taslağı + gerekçe
   → UI'da incele/düzelt → ONAYLA → profil aktif → pipeline kullanılabilir
```

**Analyst agent** (`Read/Glob/Grep` — yazma yok) şunları çıkarır:
- Repo topolojisi (tek repo mu, çok repo mu; `.gitmodules`, nested repo, default branch'ler)
- Solution/proje yapısı, SDK sürümü (`global.json`), merkezi build ayarları
- **Build komutu** ve kısıtları (Debug/Release, private feed)
- **Test projeleri** + konteynerde koşamayacaklar (denylist + gerekçe)
- **Ayağa kaldırma yolu**: compose/Dockerfile/script, portlar, bağımlılıklar, healthcheck
- **Seed/kurulum** komutu (migration'dan ayrıysa)
- **Hassas dosyalar** (`.gitignore`'daki sır taşıyanlar)
- CI kapıları (hangisi hard gate)
- **Proje çalışma kuralları** (CLAUDE.md/AGENTS.md'den: safha disiplini, commit politikası,
  review süreci) → motor davranış bayraklarına çevrilir
- Büyük CLAUDE.md'nin `paths:`-scoped kural dosyalarına bölünme önerisi

Her alan için **gerekçe ve kaynak** (dosya:satır) yazar — insan neye dayandığını görür.

**Tazelik:** elle `Yeniden analiz et`. Sistem yapısal değişiklik görürse (yeni repo, sln değişti,
compose değişti, CLAUDE.md büyük ölçüde değişti) UI'da **"profil bayatladı"** uyarısı.

---

## 4. Pipeline durum makinesi

```
Draft → Planning → PlanReview → Developing ⇄ Building → LiveTest → QACases → QA → PRReview → CIWatch → Done
                       ▲            │ (safhalı ise safha onayı)    │        │       │
                       └─ reddet ───┴──────── "düzelt" ────────────┴────────┴───────┘
                                    (her yerden) → NeedsAttention / Cancelled
```

| Durum | Aktör | Kapı | Geri dönüş |
|---|---|---|---|
| **Planning** | Planner (canlı) | — | başarısız → tekrar |
| **PlanReview** | İnsan + Planner sohbeti | **ZORUNLU** | reddet+yorum → Planning (**aynı session resume**) |
| **Developing** | Developer (canlı) | **profil: safha onayı** | — |
| **Building** | Orkestratör | — | kırmızı → Developing (hata bağlamıyla) |
| **LiveTest** | İnsan (tarayıcı) + Developer | **onay** | "düzelt" → Developing |
| **QACases** | QA case listesi sunar | **onay** (ekle/çıkar) | — |
| **QA** | QA (testleri yazar+koşar) | — | kırmızı → Developing |

**Test kapısı ikiye ayrılır** (Northwind analizi): `unit` (bağımlılıksız, hızlı — Northwind'de
in-memory SQLite) ve `integration` (servis konteyneri + ön kurulum adımı gerektirir).
Profil hangisinin hangi aşamada koşacağını söyler. Bu, DevAgent'ın tek "denylist" modelinden
daha doğru: Northwind'de koşamayan test **yok**, ayrı altyapı isteyen test var.
| **PRReview** | İnsan (profil: `openApproval`) + Developer | **onay** (PR açmadan) · tur tavanında `review_round` | reddet → Developing |
| **CIWatch** | DevOps (profil: otonom/manuel) | — | `maxIterations` → NeedsAttention |

**Safhalı mod (Northwind):** Planner planı safhalara böler (3-4 dosya tavanı, "birlikte incelenebilir
mi" ölçütü). Developer bir safhayı bitirir → **yalnızca derler** → durur → özet+diff → insan
onaylar → sonraki safha. Testler safha sonunda **koşmaz**.

**Geri adım kuralları:** kod geri alınmaz · her geçiş `job_transitions`'a yazılır · bağlam
`<feedback>` bloğuyla sınırlı taşınır · **döngü sayacı zorunlu** (`maxLoops`, varsayılan 3 →
NeedsAttention) · geçişler tek transaction'da, durum yazılmadan WS olayı yayınlanmaz.

**Kesinti dayanıklılığı:** her durum girişinde önce niyet yazılır. Açılışta `reconcile()`:
yarım kalanlar NeedsAttention'a, yetim konteynerler temizlenir, sahipsiz kaynak kiraları serbest.

---

## 5. Agent rolleri

```
agents/core/<role>.md              ← PROJE-AGNOSTİK (systemPrompt, ezilemez)
agents/core/_shared/safety.md      ← injection savunması, secret kuralları
projects/<slug>/overlays/<role>.md ← proje EKLER (appendSystemPrompt)
projects/<slug>/rules/*.md         ← paths: frontmatter, talep üzerine yüklenir
```

| Rol | Model/effort | Araçlar | Oturum |
|---|---|---|---|
| **Analyst** | opus-5-5 / high | `Read,Glob,Grep` | Tek seferlik, workspace başına |
| **Planner** | opus-5-5 / high | `Read,Glob,Grep` — **yazma YOK** | **Aynı session, resume** |
| **Developer** | opus-5-5 / high | Tam set (konteynerde) | **Resume**; safha aşırı bütçede handoff |
| **QA** | opus-5-5 / medium | Tam set; **test dizini dışına yazma DENY** | **Yeni oturum** (plan+diff) — Developer bias'ı taşımasın |
| **DevOps** | sonnet-5 / medium | `Read,Edit,Bash` + `gh` allowlist (**`gh pr merge` DENY**) | İterasyon başına yeni oturum |

**QA akışı (Northwind kuralına uyarlı):** case listesi üret → **UI'da insan ekler/çıkarır** →
onaylı listeyle testleri yaz → **tek koşu**. Sözleşme testleri kasıtlı kırıkla sınanır
(profilde açılabilir).

**Baseline ölçümü orkestratör yapar** (üretici taraf güvenilmez): QA koşmadan önce `git stash`
ile önceden-kırık testler ölçülür. Northwind'de baseline 2305/2305 temiz.

**Handoff:** biten agent `handoff.json` yazar → orkestratör eksikse git diff'ten **sentezler** →
tüketirken **Zod doğrular**. Üç katman, çünkü LLM'in dosyayı hiç yazmaması gerçek bir senaryo.

---

## 6. Canlı etkileşim

**WS olayları:** `job.state` · `agent.start/delta/message/tool_use/tool_result/question/end` ·
`approval.required` · `build.log` · `live.ready` · `cost.update`. İstemci: `subscribe` ·
`chat.send` · `question.answer` · `approval.decide` · `job.interrupt` · `live.extend`.

**Dayanıklılık:** her olayın `seq`'i; yeniden bağlanmada `subscribe{sinceSeq}` ile replay.
`agent.delta` DB'ye yazılmaz (hacim). **Backpressure:** delta'lar 50ms toplanır; istemci yavaşsa
delta atlanır ama `agent.message` gider — nihai içerik kaybolmaz.

**Streaming input:** `LiveInputChannel` (kuyruk + bekleyen promise) → `AsyncIterable<SDKUserMessage>`
→ `query({prompt: channel})`. **Tur ortasında gelen mesaj tur bitince işlenir** — UI bunu açıkça
gösterir + **"Şimdi kesip gönder"** butonu.

**Kullanıcı mesajı da VERİdir:** `<user_message>` sınırlayıcısı içinde girer; güvenlik kurallarını,
araç kısıtlarını, onay kapılarını **ezemez**.

**Agent sorusu:** doğal dil + `ask_user` MCP aracı (promise bekletir). `askTimeoutMinutes` (30)
aşılırsa "varsayımınla devam et ve raporla" — iş sonsuza asılı kalmaz.

---

## 7. İzolasyon ve kaynak

**Worktree (OverlayFS değil):** repo başına `git worktree`, iş başına workspace dizininde.
Windows'ta native, git semantiği doğal, `git worktree remove` ile temizlik. Northwind tek repo →
tek worktree (basit); Contoso çok repo → yalnız `targetRepos` materyalize edilir.
Mirror kilitleme: fetch **exclusive**, worktree **shared**, *"alamazsa ATLA"*.

### ⚠ Gitignore'lu-ama-gerçek dizinler — worktree'nin kör noktası

Northwind analizinde çıkan ve **motorun çözmesi gereken** bir sınıf: `git worktree add` yalnızca
takip edilen dosyaları taşır. Gitignore'lu ama gerçek olan içerik yeni worktree'de **hiç olmaz**:

| Yol | Ne | Sonuç |
|---|---|---|
| `Northwind.Forms/` | **Nested repo** (submodule DEĞİL, `.gitmodules` yok), remote'u **yerel disk yolu** | Worktree'de yok; `git clean -xfd` commit edilmemiş işi **siler**. Derlemeye girmiyor → build için gerekmiyor |
| `Northwind.Host/appsettings.json` | Sır taşır | **Zaten şablondan üretilecek** (ön koşul adımı) |
| `plans/`, `.plans/`, `handoff/`, `docs/` | Plan ve tasarım disiplini | Agent'ın plan bağlamını kaybetmesi — profil `contextPaths` ile **kopyalanmalı** |
| `.run/` | **Canlı JWT + 5 MB log** | Worktree'ye **ASLA kopyalanmamalı** |
| `sp.json` (3.2 MB) | — | Gereksiz |

**Profil çözümü:** `workspace.ignoredButNeeded[]` (worktree'ye kopyalanacaklar) ve
`security.neverCopy[]` (asla taşınmayacaklar) ayrımı. Analyst bunları `.gitignore` + dizin
taramasıyla aday olarak çıkarır, insan onaylar.

### Hassas yollar (Northwind — `sensitiveFiles`)

`.run/**` (**canlı bearer token: `at.txt`, `token.json`, `token.txt`**) · `appsettings.json` ·
`appsettings.Development.json` · `**/App_Data/dataSettings.json` · `deploy/.env` ·
`deploy/servers/*/.env`

**Context patlatanlar** (agent'a asla ham verilmez): `CLAUDE.md` 487 KB · Nebim `CLAUDE.md`
127 KB · `run.ps1` 61 KB · `.coderabbit.yaml` 35 KB · `.run/host.log` 1.5 MB ·
`.run/dummy-host.log` 3.4 MB · `sp.json` 3.2 MB.
→ Log okuma **hedefli** olmalı (`tail -N` veya `Registered (\d+) endpoints` gibi regex),
"logları oku" adımı yasak.

**Port havuzu:** `resource_leases` tablosunda transaction'lı; tahsis öncesi **gerçek
bağlanabilirlik kontrolü** (Windows'ta WinNAT excluded range gerçek sorun).

**İzole DB — golden klonu:** golden bir kez kurulur (**migration + seed ayrı adım**), veri dizini
saklanır, iş başına kopyalanır.
**Windows kritik detayı:** bind-mount'ta PostgreSQL yavaş → **named volume** + konteyner içi
kopyalama (`docker run --rm -v golden:/from -v job:/to alpine cp -a /from/. /to/`). Host dosya
sistemi devreye girmez.

**Cache:** NuGet/npm named volume, **mount edilir kopyalanmaz**.

**Kimlik havuzu:** kimlik `query()` başına `options.env` ile; `process.env`'e asla yazılmaz
(paralel işler birbirini ezer). **Kota imzası yalnız SDK hata nesnesinde ve `result` mesajında
aranır, asistan metninde ASLA** ("rate limit" konulu iş yanlış pozitif üretmişti).

**Eşzamanlılık:** `maxActiveJobs:5` · `maxConcurrentBuilds:2` (CPU) · `maxLiveEnvironments:3`
(RAM) — 8 CPU/16 GB gerçeğinden türetilmiş.

**Temizlik:** TTL dolmuş canlı ortamlar, yetim konteynerler, bitmiş iş worktree'leri.
**Başarısız işlerin worktree'si SAKLANIR** (post-mortem).

---

## 8. Canlı test ortamı

Build yeşil → port + DB klonu kiralanır → profilin `live` tanımından compose **override üretilir**
(portlar havuzdan, volume'ler iş başına, ağ adı) → uygulama build → healthcheck poll →
`live.ready` → UI'da **"Uygulamayı aç"**.

Kullanıcı test ederken **Developer canlı** — "şu buton yanlış" yazınca düzeltir, hızlı yeniden
build. Onay → QA. TTL 120 dk, uzatılabilir.

**Northwind özelinde:** host 5080, panel 5173, healthcheck `/api/ping`, bağlantılar `__` env
kuralıyla (`DataSettings__DataConnectionString`, `Northwind__Redis__ConnectionString`).
**ES boş bırakılır** — "dolu ama erişilemez" host'u açılışta öldürür (CI'da bile boş).
`run.ps1` PowerShell → konteynerde **`pwsh`** gerekir; alternatif olarak komutlar ayrıştırılır.

**Uzak erişim:** `proxy` varsayılan (tek port dışarı, auth orch oturumuyla paylaşılır);
`PathBase` sorun çıkarırsa `direct`. **Ağ izolasyonu:** iş başına bridge, `internal` varsayılan.
**Prod veri asla kullanılmaz.**

---

## 9. Veri modeli

**Drizzle** (SQLite↔PG neredeyse aynı API). **Taşınabilirlik kuralları:** PK **TEXT UUIDv7** ·
zaman **TEXT ISO-8601 UTC** · boolean **INTEGER 0/1** · JSON **TEXT** + Zod · para **INTEGER
mikro-dolar** · ENUM yok (**TEXT + CHECK + TS union**) · büyük metin ayrı tabloda.

**Tablolar:** `projects` · **`project_profiles`** (versiyonlu, onay durumlu) · **`workspace_analyses`**
(Analyst çıktısı + gerekçe + bayatlık) · `jobs` · `job_transitions` · `plans` (versiyonlu) ·
**`plan_phases`** (safhalar + onay durumu) · `agent_sessions` · `agent_runs` · `messages` ·
`job_events` · `approvals` · **`qa_cases`** (öneri + insan eklemesi) · `artifacts` ·
`pull_requests` · `test_runs` (+`preexisting_failures`) · `builds` · **`resource_leases`**
(`UNIQ(kind,value) WHERE state='held'`) · `live_environments` · `cost_records` · `identities`
(**anahtar ASLA burada değil**) · `runners` · `users`/`api_tokens` · `audit_log`.

**`external_ref` + `source`** — taşıyıcıya özel alan (`clickUpTaskId` gibi) şemaya asla girmez.

`messages.content` 64KB üstü → `artifacts`'a dosya, satırda özet+referans.

---

## 10. Proje profili

`projects/<slug>/profile.yaml` — Analyst üretir, insan onaylar, Zod doğrular.

Bölümler:

- **`workspace`** — repo topolojisi, default branch'ler, **`ignoredButNeeded[]`** (worktree'ye
  kopyalanacak gitignore'lu içerik: `plans/`, `docs/`), **`nestedRepos[]`** (submodule sanılmasın)
- **`exec`** — agent imajı, limitler, cache, **egressAllowlist**
- **`build`** — **sıralı adımlar** (Northwind: npm-modüller → npm-kabuk → dotnet; ters sıra sessiz
  hata) · **koşullu eşleme** (`.cs`→dotnet, `.tsx`→npm) + **istisna listesi** (kaynak metni okuyan
  sözleşme testleri) · **`preSteps`** (appsettings şablonu kopyala, host durdur) ·
  **`forbiddenFlags`** (`-c Release`, `-warnaserror`) · `failureIsBlocking`
- **`test`** — **`suites[]`**: `unit` (bağımlılıksız) ve `integration` (servisler + **`preSteps`**:
  install/seed) · `baseline:true` · `caseApproval:true`
- **`live`** — compose/script, portlar, bağımlılıklar, **`emptyEnv[]`** (ES/Rabbit `' '` tek
  boşluk — boş dize değişkeni **siler**), healthcheck + **`readinessLogPattern`**
  (`Registered (\d+) endpoints`, N>0), `access`, `ttl`
- **`database`** — golden volume, **migration + seed AYRI adım**, `goldenMaxAgeDays`
- **`git`** — branch/commit/PR şablonları, `draft:false` (CodeRabbit taslağı incelemez), **`branchRequired:false`** (Northwind)
- **`workflow`** — `developing: phased|single`, `phaseMaxFiles:4`, `review.autoTrigger:false`,
  `commitPolicy: onApproval`
- **`agents`** — overlay/rules/skills, rol başına model/effort/**maxBudgetUsd**,
  **`contextBudget`** (büyük dosyalar ham verilmez: CLAUDE.md 487 KB)
- **`security`** — **`sensitiveFiles`** (worktree'den silinir) · **`neverCopy[]`** (`.run/` —
  canlı token) · **`logReadPolicy: targeted`** · `deniedTools` · `deniedBashPatterns`
- **`limits`**

**`ahtapot project validate <slug>` Faz 1'de yazılır** — repolar, remote'lar, compose parse,
imaj çekilebilirliği, port müsaitliği. Kötü profil en pahalı hata sınıfı.

---

## 11. UI

React + Vite + Tailwind + shadcn/ui; sunucu statik serve eder.

**Sayfalar:** `/` dashboard (dikkat bekleyenler üstte) · `/workspaces` (bağla, analiz, **profil
onayı**, bayatlık) · `/jobs` · `/jobs/new` · **`/jobs/:id`** · `/jobs/:id/sessions` · `/costs` ·
`/system`.

**İş detayı — üç sütun:**
- **Sol:** dikey pipeline, **safha listesi + onay durumu**, döngü sayaçları
- **Orta (tab'lı):** Sohbet (token akışı, katlanabilir araç çağrıları, **mesaj kutusu her zaman
  etkin** + "kesip gönder") · Plan (safhalı görünüm, versiyon diff, onay/red) · Diff ·
  **QA case'leri (ekle/çıkar)** · Testler (**önceden kırıklar ayrı ve gri**) · Loglar
- **Sağ:** onay kartları · canlı ortam (aç/uzat/yık) · PR + CI check'leri · maliyet (bütçe barı)

**Zor detaylar:** dikişsiz yeniden bağlanma (`sinceSeq`) · uzun akış sanallaştırma · araç çıktısı
kesilmiş + "tamamını göster" · canlı maliyet · onay kapıları kaçırılamaz.

---

## 12. Güvenlik

**DevAgent'tan taşınanlar:** kimlik havuzu + devretme · kota imzası dar tespiti · konteyner
sertleştirme (`--cap-drop ALL`, `no-new-privileges`, pids/mem/cpu, **docker.sock YOK**, TTL) ·
egress allowlist · **secret scrubbing** (DB'ye/WS'e giden her metin: `sk-ant-`, `gh[pousr]_`,
`pk_`, `st_`, `AKIA`) · üç katmanlı çıktı doğrulama · injection savunması.

**Yeni:** UI/WS auth (Faz 1: tek kullanıcı + token, `127.0.0.1`; Faz 4: roller, TLS; **token query
string'de taşınmaz**) · XSS (markdown sanitize, `dangerouslySetInnerHTML` yok) · docker.sock asla
mount edilmez, canlı ortamı **orch yönetir** (agent MCP aracı çağırır) · git token yalnız branch
push + draft PR, **merge/force-push yok** · denetim izi (heartbeat'ler **yazılmaz**).

---

## 13. Aşamalandırma

**Faz 1 — Workspace + ince dilim.** `git init`, Fastify+WS iskeleti, Drizzle şeması, **Analyst
agent + profil onayı + `project validate`**, worktree yöneticisi, **kalıcı agent konteyneri + WS
köprüsü**, Planner+Developer (safhalı mod), build kapısı (koşullu), UI (workspace + iş listesi +
detay + plan/safha onayı + build logu).
→ *Northwind'i bağla, analizi onayla, iş gir, planı tartış, safha safha onayla, build sonucunu gör.*

**Faz 2 — Canlı test + izolasyon.** Port havuzu + kaynak kiraları, golden DB (migration+seed),
compose override üretici, healthcheck, ters proxy, LiveTest kapısı, çoklu repo worktree.
→ *Kendi portunda kendi DB'siyle uygulamayı test edip "düzelt" diyebiliyorsun.*

**Faz 3 — QA + PR + DevOps.** QA case akışı + baseline + denylist + trx parse, QA yazma kısıtı,
draft PR + PRReview, DevOps (CI izleme; Northwind'de review kapalı), UI testler/PR kartları.
→ *Tam pipeline Done'a kadar.*

**Faz 4 — Sağlamlaştırma.** 5+ paralel semaforlar, kimlik havuzu + cooldown UI, `reconcile()`,
WS replay + backpressure, auth/roller/TLS, güvenlik hook'ları için birim testleri, maliyet sayfası.

**Faz 5 — Genişleme.** PostgreSQL geçişi · **ikinci profil: Contoso (çok-repo topolojisi) —
proje-agnostikliğin gerçek testi** · çoklu runner · ClickUp/Jira içe aktarma.

---

## 14. Riskler ve açık sorular

**Yüksek**
- **R1 Windows Docker I/O.** Worktree bind-mount'undan .NET build'i yavaş olabilir.
  **Faz 1'de ilk ölçülecek şey**; yavaşsa worktree de volume'e senkronlanır.
- **R2 Tur sınırı gecikmesi.** Kullanıcı mesajı tur bitince görülür; UI göstergesi + "kesip
  gönder" ile azaltılır, kalıcı çözüm deneyle.
- **R3 Egress firewall Windows'ta yok.** `ipset`/`iptables` Linux'a özel; lokalde `internal` ağ +
  proxy ile telafi. **Lokal ve sunucu güvenlik seviyesi eşit değil** — bilinçli kabul.
- **R4 `run.ps1` bağımlılığı.** Northwind'in kanonik ayağa kaldırma yolu PowerShell ve Windows
  yollarına (`e:/dockerData/pgdata`, `taskkill`) bağlı. Konteynerde `pwsh` + Linux uyarlaması
  gerekir; alternatif komutları ayrıştırmak. **Faz 2'nin en riskli parçası.**
- **R5 Golden DB bayatlığı.** Şema göç ederse canlı test yanıltıcı olur → `goldenMaxAgeDays` +
  uyarı + klon üzerinde migration koşturma.

**Orta**
- **R6 Maliyet.** 5 paralel Opus pahalı; rol bütçesi + döngü tavanı + canlı gösterge var,
  gerçek rakamlar Faz 1 sonrası.
- **R7 Bağlam penceresi.** Safhalı mod bunu **azaltıyor** (her safha dar) ama uzun fazlarda
  handoff kalitesi belirsiz.
- **R8 16 GB RAM tavanı.** Northwind yığını PG+Redis+ES+Rabbit+app; `maxLiveEnvironments:3` bu
  yüzden. Profil ağır bağımlılıkları `optional` işaretleyebilmeli (ES boş bırakılabiliyor).
- **R9 CLAUDE.md 487 KB.** Her işin bağlamına girmesi israf; `paths:`-scoped bölme öneriliyor
  ama bölmeyi kim yapacak (Analyst mi, insan mı) Faz 1'de netleşir.

**Açık sorular (deneyle)**
1. Developer safhalar arası tek session mı, safha başına yeni mi?
2. QA'nın Developer transcript'ini görmemesi doğru mu?
3. Build'i agent mı orkestratör mü koşmalı? (**melez muhtemelen doğru**: orkestratör koşar,
   çıktıyı agent'a araç sonucu olarak verir)
4. Canlı test sırasında Developer canlı mı kalmalı? (idle maliyet ↔ akıcılık)
5. Northwind `PathBase` ile ters proxy altında çalışır mı?

---

## Doğrulama

- **Faz 1:** `ahtapot project validate northwind` yeşil · Analyst profili çıkarır, gerekçeleri
  dosya:satır ile gösterir, onaylanır · iş açılır, Planner planı **safhalara böler** (3-4 dosya) ·
  sohbetten "şu safhayı çıkar" denince plan güncellenir · Developer safha 1'i yazar, **yalnız
  derler**, durur, onay bekler · kırmızı build Developing'e döndürür.
- **I/O ölçümü (R1):** aynı `dotnet build Northwind.slnx` hem bind-mount hem named volume üzerinde;
  süreler karşılaştırılır.
- **Koşullu build (Northwind kuralı):** yalnız `.tsx` değişen bir işte `dotnet build`
  **koşmamalı**; sözleşme testinin okuduğu bir `.tsx` değişirse **koşmalı**.

- **"6 hata" kabul testleri** (analizden — Faz 1-2'de her biri ayrı sınanır):
  1. Profil `-c Release` denemesini **reddetmeli** (`forbiddenFlags`)
  2. appsettings şablonu kopyalanmadan build başlatılmamalı (`preSteps`)
  3. **npm adımları dotnet'ten önce koşmalı** — ters sırada publish yeşil ama panel ekransız;
     test: modül bundle'ı `wwwroot/modules/*.js` HTTP 200 dönmeli
  4. Host ayaktayken build tetiklenirse **önce host durdurulmalı** (MSB3027 çıkmamalı)
  5. `Northwind.Forms/` worktree'de yokken build **yine de geçmeli**; `git clean -xfd`
     **çalıştırılmamalı** (nested repo koruması)
  6. `.run/**` hiçbir log/artifact/agent bağlamına **girmemeli** — sahte token yerleştirilip
     sızmadığı doğrulanır

- **Faz 2:** iki iş paralel canlı ortam alır, portları/DB'leri çakışmaz · `/api/ping` 200 **ve**
  log'da `Registered N endpoints` N>0 (sıfır route ile "hazır" denmemeli) · ES `' '` ile
  bırakıldığında host **ölmemeli**; dolu+erişilemez senaryosunda **ölmesi beklenir** (ayırt
  edilmeli).
- **Faz 3:** QA case listesi sunar, insan case ekler, testler o listeyle yazılır · `unit` ve
  `integration` **ayrı kapı** olarak koşar; integration'da install adımı atlanırsa testler
  **yanlış yönde geçer** — bu senaryo kasten kurulup yakalandığı doğrulanır ·
  `gh pr merge` denemesi **reddedilmeli** · Northwind'de CodeRabbit **otomatik tetiklenmemeli** ·
  **otomatik commit/PR yasağı** (CLAUDE.md:31-40) onay olmadan delinmemeli.
- **Faz 4:** `kill -9` sonrası `reconcile()` yetimleri temizler, kiraları serbest bırakır ·
  WS kopar/döner, `sinceSeq` ile kayıpsız · sahte `sk-ant-` token'ı log'a yazılır, DB'de ve UI'da
  **maskeli** görünmeli.
- **Faz 5:** Contoso (çok-repo) profili eklenir ve Faz 1-3 uçtan uca koşar — proje-agnostiklik
  ancak böyle kanıtlanır.
