# Kararlar ve gerekçeleri

Bu belge "neden böyle yapıldı" sorusunun cevabıdır. Plan *ne* yapılacağını
söyler; burası *niçin öyle* olduğunu. Bir kararı değiştirecekseniz önce buradaki
gerekçeyi okuyun — çoğu ölçülmüş bir bedele dayanıyor.

## 1. Neden yeni bir sistem, DevAgent'ı genişletmek yerine

`AdventureWorks.DevAgent` çalışan bir sistem: ClickUp etiketi → kuyruk → izole
konteyner → draft PR. Ama iki yapısal sınırı var:

- **Tek atışlık ve kör.** `claude -p` çağrısı tek yönlü: akış dışarı çıkıyor,
  içeri mesaj giremiyor. İş başladıktan sonra yön verilemiyor.
- **Taşıyıcıya bağlı.** ClickUp ve AdventureWorks varsayımları koda gömülü.

Canlı etkileşim, orkestratörün bash betiği değil **uzun ömürlü, durumlu bir
uygulama** olmasını gerektiriyor. Bu, `agent-host.sh`'ın akış kontrolünü
emsal olmaktan çıkarıyor.

**DevAgent'tan alınanlar** (yaşanmış hatalardan damıtılmış, domain-agnostik):
kimlik havuzu ve kota devretme, kota imzasının dar tespiti, konteyner
sertleştirme, egress allowlist, secret scrubbing, "üretici taraf güvenilmez"
üç katmanlı doğrulama, injection savunması, build/test kapıları.

**Tekrarlanmayan hatalar:** `clickUpTaskId` gibi taşıyıcıya özel bir alan wire
şemasına sızmıştı → `externalRef` + `source` ayrımı. Şema markdown'da tanımlı
olup beş yerde tüketiliyordu → tek Zod kaynağı.

## 2. SDK konteyner içinde, kalıcı konteynerde

Tasarım agent'ı SDK'nın host'ta koşmasını önerdi (canlı sohbet kolay olsun diye),
ama bunun bedeli agent'ın dosya yazmasının host'a taşınması ve güvenliğin tek bir
`PreToolUse` yol-kontrol fonksiyonuna indirgenmesiydi — kendi risk listesinde
"yüksek risk" diye işaretlemişti.

**Kalıcı konteyner üç itirazı birden çözüyor:**

| İtiraz | Çözüm |
|---|---|
| Streaming input çift yönlü kanal ister | Konteyner içindeki köprü sunucuya **dışarı doğru** WS açar; porta gerek yok |
| Transcript kalıcılığı (`resume`) | Transcript worktree altında, bind-mount'ta kalıcı |
| Kimlik devretme konteyneri öldürür | **Öldürmez:** kimlik `query()` başına `options.env` ile verilir |
| İki atlama gecikmesi | Köprü delta'ları 50 ms pencerelerde toplar |

Kazanç: DevAgent'ın güvenlik sınırı aynen korunuyor. Bedel: konteyner içinde
~200 satırlık bir köprü süreci. Kabul edilmiş takas.

## 3. OverlayFS değil, git worktree

Hedef projeler çok repolu olabiliyor ve sistem Windows'ta da koşmalı.

| Kriter | OverlayFS | git worktree |
|---|---|---|
| Windows | yok | native |
| Disk | çok verimli (CoW) | çalışma ağacı kopyası (`.git` paylaşılır) |
| Kurulum | root + mount izni | yok |
| Git semantiği | branch/ref durumu lower'dan miras — kafa karıştırıcı | doğal: her worktree kendi HEAD'i |

Disk bedeli gerçek ama kabul edilebilir. Kritik avantaj: her iş kendi branch'inde,
`git status` temiz, PR açmak doğal.

**Worktree'nin kör noktası** (Northwind analizinde çıktı): `git worktree add` yalnız
takip edilen dosyaları taşır. Gitignore'lu ama gerçek içerik yeni ağaçta **hiç
olmaz**. Northwind'de `plans/` ve `docs/` agent'ın plan bağlamını taşıyor, `.run/`
ise **canlı JWT token**. Biri kopyalanmalı, diğeri asla — bu yüzden profilde
`workspace.ignoredButNeeded[]` ve `security.neverCopy[]` ayrı alanlar.

## 4. İş başına izole DB, named volume ile

Paylaşımlı test DB'si migration çakışması ve veri kirlenmesi üretir; paralel iş
sayısı pratikte 1'e düşer.

**Windows kritik detayı:** Docker Desktop'ta bind-mount ile PostgreSQL yavaş.
Çözüm named volume + konteyner içi kopyalama
(`docker run --rm -v golden:/from -v job:/to alpine cp -a /from/. /to/`) —
host dosya sistemi devreye girmez, hem hızlı hem platformdan bağımsız.

`pg_dump`/restore dakikalar sürer, dosya kopyası saniyeler.
`CREATE DATABASE … TEMPLATE` tek PostgreSQL örneği paylaşmak demek, izolasyon
şartına uymaz.

## 5. Motor yetenek sunar, profil seçer

Bu, proje-agnostiklik iddiasını gerçek kılan karar. Northwind'in CLAUDE.md'si
sistemin varsayılan davranışıyla dört yerde çelişiyordu; hiçbiri motora
gömülmedi, hepsi profile alan oldu:

| Northwind kuralı | Profil alanı |
|---|---|
| "Her safhadan sonra DUR ve onay iste" | `workflow.developing: phased` |
| "Safha sonunda yalnızca derleme, test değil" | `workflow.phaseRunsTests: false` |
| "Test case'leri kullanıcıdan sorulur" | `test.caseApproval: true` |
| "Code review DIŞ süreçtir" | `workflow.review.autoTrigger: false` |
| "İş tamamlanınca commit yapma, PR açma" | `workflow.commitPolicy: onApproval` |
| "Derleme yalnızca dokunulan katmanda" | `build.steps[].whenChanged` + `exceptPaths` |

Yeni bir davranış eklerken sorulacak soru: *bu her proje için doğru mu, yoksa bu
projenin tercihi mi?*

## 6. Analyst agent profili çıkarır, insan onaylar

Profil elle yazılan bir YAML değil. Northwind'in 5053 satırlık CLAUDE.md'si,
61 KB'lık `run.ps1`'i ve üç CI workflow'u varken elle profil yazmak hem yorucu
hem hataya açık.

**Ama tam otonom da değil:** yanlış bir build komutu her işi bozar. Agent taslak
üretir (`draft`), insan inceler ve onaylar (`approved`); yalnız onaylı profil
pipeline'da kullanılır. `activeProfile()` taslağı döndürmez.

**Mekanik olan mekanik kalır.** Repo listesi, varsayılan dallar, gitignore'lu
yollar, büyük dosyalar — bunlar `scan.ts` ile ölçülür, modele sordurulmaz.
Agent'ın işi *yorumlamak*: hangi komut derler, hangi test neyi ister.

**Bayatlık takibi:** yapısal imza (solution/compose/doküman hash'leri + repo
listesi) saklanır. Değiştiğinde UI "profil bayatladı" uyarır, iş durdurulmaz.

## 7. Test kapısı ikiye ayrıldı

İlk tasarım DevAgent'tan "denylist" modelini devralmıştı: konteynerde koşamayan
testleri dışla. Northwind analizi bunun yanlış soyutlama olduğunu gösterdi —
koşamayan test **yok**, ayrı altyapı isteyen test var:

- `Northwind.Base.Tests` → in-memory SQLite, **dış bağımlılık yok**, konteyner dostu
- `Northwind.IntegrationTests` → gerçek Postgres + Redis **ve zorunlu bir kurulum
  adımı**

O kurulum adımı atlanırsa izin tablosu boş kalır, her uç 403 döner ve izolasyon
testleri **"çalışıyor" diye yanlış yönde geçer**. Bu sınıf hata (yeşil görünen
bozuk sonuç) profilde `test.suites[].preSteps` ile karşılanıyor.

## 8. Northwind'den öğrenilenler

Analiz, motorun desteklemesi gereken yetenekleri belirledi:

**Build sırası bağlayıcı olabilir.** Northwind'de npm (modül ekranları → kabuk)
.NET'ten önce koşmak zorunda. Ters sırada `dotnet publish` **başarılı olur** ama
panel sessizce ekransız açılır. En pahalı hata sınıfı budur: yeşil görünür.

**"Port açık" ≠ "uygulama hazır".** FastEndpoints uçları kaydederken ayarları
veritabanından çeker; bağlantı yoksa hatayı **yutar** ve süreç sıfır route ile
dinlemeye devam eder. Gerçek ölçüt log'daki `Registered N endpoints`, N>0 →
profilde `live.readiness.logPattern`.

**Boş dize değişkeni siler.** .NET'te bir ortam değişkenini boş dizeye ayarlamak
onu kaldırır ve appsettings değeri geri gelir. Elasticsearch'ün "tanımlı ama
erişilemez" hâli host'u açılışta öldürüyor, bu yüzden **tek boşluk** geçilmeli →
profilde `live.emptyEnv[]`.

**Yasak bayraklar gerçek.** `-c Release` private paket deposuna düşüyor ve
secret'sız 401 dönüyor — bu bir kısıt, tercih değil → `build.forbiddenFlags`.

**Nested repo ≠ submodule.** `Northwind.Forms` kök repo tarafından yok sayılan
bir git reposu, remote'u yerel disk yolu. `git clean -xfd` commit edilmemiş işi
siler → `workspace.nestedRepos[]` ile kayıt altındaydı (§16'da kaldırıldı).

## 9. Ölçülmüş ortam gerçekleri

- Docker Desktop **WSL2** üzerinde: `overlay2`, kernel 5.15, OSType=linux →
  konteyner tarafı lokalde ve sunucuda **aynı**.
- **8 CPU / 16 GB RAM.** 5 paralel iş × (uygulama + PG + Redis + ES) bu makineyi
  aşar → `maxLiveEnvironments: 3` keyfi değil, bu ölçümden.
- Disk 411 GB boş; Northwind ağacı ~11 GB.

## 10. Claude Max/Pro aboneliğiyle çalışır

Agent SDK abonelik kimlik doğrulamasını destekliyor: `claude setup-token` ile
üretilen token `CLAUDE_CODE_OAUTH_TOKEN` olarak geçer, API anahtarı gerekmez.
`identity.ts` anahtarı önekinden tanıyor (`sk-ant-oat…` → abonelik).

Abonelik kotası paylaşımlı olduğu için kimlik havuzu ayrıca değerli: birden çok
token tanımlanıp kota dolduğunda devredilebiliyor.

## 11. R1 ölçüldü: bind-mount yavaş, worktree named volume'e taşınmalı

2026-09-13, Docker Desktop (WSL2, Engine 29.6), `mcr.microsoft.com/dotnet/sdk:10.0`
(10.0.401), gerçek Northwind worktree'si (2777 dosya, 26 MB kaynak), aynı NuGet
cache volume'ü, arka arkaya aynı makinede:

| Ölçüm | Bind-mount (`C:\…`) | Named volume | Host Windows dotnet |
|---|---|---|---|
| `dotnet restore` (sıcak cache) | 54,1 s | 9,0 s | — |
| `dotnet build -c Debug` (tam) | **272,0 s** | **134,7 s** | 27,7 s |
| `dotnet build` (artımlı, değişiklik yok) | **89,6 s** | **18,6 s** | 5,6 s |
| Temiz ağacı volume'e kopyalama | — | 11,2 s | — |

Named volume tam build'de 2×, **artımlı build'de 5×** hızlı. Geliştirme
döngüsünün ölçüsü artımlıdır: safha başına 90 s'lik "değişiklik yok" derlemesi
kabul edilemez, 19 s edilebilir. Host'un 5,6 s'si ise konteynerin bedelini
gösteriyor — güvenlik sınırı için ödenen fiyat bu.

Not: bind-mount "soğuk" restore (15,4 s) sıcaktan hızlı çıktı; ilk koşu
yarıda kesilmiş bir denemenin cache'inden yararlandı. Sıcak sayılar geçerli.

**Karar (öneri, insan onayı bekliyor):** worktree konteynerin named
volume'ünde yaşar, git komutları (diff, add, commit, status) konteynerde
`docker exec` ile koşar. Host'ta yalnız mirror kalır. Alternatif — host
worktree'sini her build'den önce volume'e senkronlamak — her safhada iki
yönlü kopya ve "hangisi doğru" belirsizliği getirir; reddedildi.

Bedeli: `WorktreeManager` konteyner tarafına taşınır (mirror volume ya da
salt okunur bind-mount'tan `git worktree add`), safha diff'i ve commit'i
`ContainerExecutor` üzerinden alınır, host'taki UI'ın "dosyayı aç" gibi
yolları konteyner yollarına döner. Linux sunucuda fark yoktur: bind-mount
zaten native.

## 11b. R1 doğrulandı: bind-mount `npm ci`'yi SESSİZCE BOZUYOR

§11 bind-mount'u yavaşlığı için eleştiriyordu. 2026-09-15'te ölçülen daha ağır:
**bind-mount üzerinde `npm ci` eksik kuruyor ve bunu hata olarak bildirmiyor.**

Aynı `package.json` + aynı `package-lock.json` (Northwind.Catalog/wwwroot, lock'ta
192 paket), aynı konteyner:

| Hedef | Süre | `node_modules` | `.bin/tsc` | `typescript/lib/lib.dom.d.ts` |
|---|---|---|---|---|
| Bind-mount (Windows) | 2 dk | 21 girdi | yok | **yok** |
| Konteyner FS | **10 s** | 70 girdi | var | **var** |

Belirti zinciri: npm `TAR_ENTRY_ERROR ENOENT` uyarıları basıyor, ardından
"added 159 packages" diyor ve **çıkış 0** dönüyor. Sonra `npm run build`
`sh: tsc: not found` ile düşüyor; `tsc` bulunsa bile TypeScript'in kendi lib
dosyaları eksik olduğu için `TS6053` yağıyor.

`--maxsockets 1` kısmen düzeltiyor (21 → 65 girdi, `tsc` beliriyor) ama yeterli
değil: lib dosyaları yine eksik. Yani eşzamanlılık tek sebep değil.

**Sonuç:** §11'in "worktree named volume'de yaşar" önerisi artık performans
tercihi değil, **doğruluk şartı**. Bind-mount üzerinde npm kuran her proje
sessizce bozuk çıktı üretir — Northwind'in build sırası dersiyle (`npm → dotnet`,
tersi sessizce bozuk) aynı sınıf: yeşil görünüp yanlış olan hata.

Bu ölçümden önce `npm: modüller` adımı beş kez kırmızı dönüp işi `build_loop`
ile durdurdu; sebebi iki katmanlıydı — profildeki yol hatası (`Partials/*/ui`,
doğrusu `*/wwwroot`) ve altındaki bu bind-mount kusuru.

## 11c. `npm ci` scratch symlink'ini siliyor — ama asıl çözen süreç ayrımıydı

İki gerçek, ikisi de 2026-09-16'da Collection işinde ölçüldü. Sıraları önemli,
çünkü ilki tek başına yanlış sonuca götürüyor.

**1. `npm ci` scratch symlink'ini siliyor.** `exec.scratchDirs` hedefi konteyner
diskine taşıyıp worktree'ye symlink koyuyor; `npm ci` o symlink'i "mevcut
`node_modules`" sayıp siliyor ve yerine gerçek dizin açıyor. Log'daki satır
bunu söylüyordu, gözden kaçmıştı:

```
npm warn reify Removing non-directory /workspace/.../node_modules
```

`df` ile doğrulandı: kurulum sonrası hedef `C:\ /workspace` (bind-mount)
üzerinde, `/tmp/ahtapot-scratch` ise `overlay /` üzerinde. Yani scratch koruması
ilk kurulumda devre dışı kalıyor. Bu npm'in dokümante davranışı.

**2. Buna rağmen kurulum DOĞRU bitti.** Koşu bittikten sonra, bind-mount'ta:

| Modül | girdi | `.bin/tsc` |
|---|---|---|
| Partials/* (7 modül) | 69-70 | var |
| Northwind.Web | 81 | var |

§11b'nin "doğru kurulum" ölçütü (70 girdi, `tsc` var) her modülde tutuyor —
oysa §11b'de aynı bind-mount'ta 21 girdi ve `tsc` yoktu.

**Farkı yaratan bind-mount değil, SÜREÇ AYRIMI.** §11b'de `npm ci` ve
`npm run build` aynı adımdaydı ve bu adım her build döngüsünde baştan
koşuyordu: yarım kalan kurulumun üstüne yenisi biniyordu. `exec.setup` ile
kurulum bir kez, tek başına, derleme baskısı olmadan koşunca tamamlanıyor.

**Ders — ölçümü erken okumak:** koşu sürerken bakıldığında tablo
"DIZIN 80 / symlink 1 / symlink 0" görünüyordu ve bu "kurulum yine bozuk"
diye okunmuştu. Oysa `npm ci` sırayla çalışıyordu: 80 biten modül, 1 ve 0
henüz başlamamışlar. Yarıda okunan ölçüm ölçüm değildir.

**Bugünkü durum:** scratch symlink'leri ilk `npm ci`'de siliniyor, yani
`exec.scratchDirs` şu an hiçbir şey yapmıyor. Kurulum çalıştığı için bu acil
değil ama bedeli var — her iş kendi kurulumunu bind-mount'ta baştan yapıyor
(ölçüldü: 8 modül ~17 dk; konteyner diskinde §11b'ye göre modül başına 10 s).

Seçenekler:

1. **Kurulumu scratch'in içinde koştur** — `cd $store && npm ci`; npm kendi
   dizinindeki `node_modules`'ı siler, symlink'i değil.
2. **`node_modules`'ı named volume ile mount et** — npm silse de mount noktası
   kalır. §11'in R1 önerisiyle birleşir.
3. `--install-links` gibi npm ayarları — sürüme bağlı, kırılgan.

Karar verilmedi; kurulum doğru çalıştığı sürece bu bir hız işi, doğruluk işi
değil. §11b'nin "bind-mount = doğruluk şartı" hükmü bu ölçümle **yumuşuyor**:
şart olan, kurulumun derlemeden ayrı ve tek sefer koşması.

## 11d. Karar: scratch KALDIRILDI — workspaces onu gereksiz kıldı

**Ölçüldü (2026-09-17, Sipariş notları işi, konteyner içinde.)** §11c'deki üç
seçenek de gereksiz çıktı, çünkü zemin değişti: Northwind modülleri npm workspace
üyesi oldu (Northwind PR #116) ve on ayrı `npm ci` yerine kökte **tek** kurulum
koşuyor.

Aynı konteynerde, aynı lock:

| Yol | Süre | Sonuç |
|---|---|---|
| Bind-mount, scratch YOK | **215 s** | 91 girdi, `.bin/tsc` var, `tsc -v` → 5.9.3 |
| Scratch'li | ~3 dk kurulum + **~6 dk taşıma** | aynı sonuç |

Yani scratch **kurulumun kendisinden pahalı**: bind-mount'tan konteyner diskine
1,4 GB kopyalamak, oraya kurmaktan uzun sürüyor.

§11b'nin "bind-mount npm ci'yi sessizce bozuyor" ölçümü YANLIŞ DEĞİLDİ ama
koşulu değişti: o ölçüm **on ayrı modül kurulumu** dönemine aitti ve §11c'nin
gösterdiği gibi asıl sebep süreç ayrımıydı. Tek kök kurulumunda kurulum eksiksiz
bitiyor — ölçütü (`tsc` çalışıyor, lib dosyaları yerinde) sağlıyor.

Scratch'in vaat ettiği "sonraki koşu hazır bulur" kazancı da gerçekleşmiyordu:
anahtar lock'tan türüyor ve lock her değiştiğinde kova ıskalanıyor. Loglarda her
koşuda `0 yeniden kullanıldı` görülüyordu.

**`exec.scratchDirs` boşaltıldı** (profil v10). Alan motorda KALIYOR: başka bir
proje bind-mount'ta gerçekten bozuk kurulum yaşarsa ihtiyaç duyabilir — motor
yeteneği sunar, hangisinin geçerli olduğunu profil söyler.

Bu ölçüme giden yolda bulunan ve düzeltilen bir kusur: scratch kovası
`node_modules` adını taşımıyordu ve Node'un modül çözümlemesi dizin ADINA baktığı
için `typescript`, kardeşi `@typescript/typescript-linux-x64`'ü bulamıyordu
(TypeScript 7 native ikiliyi optional dependency olarak taşıyor). Kova artık
`<kova>/node_modules` ile bitiyor. Scratch kullanılmasa da bu düzeltme durur.

## 12. Çok sağlayıcılı roller: kapı açık, kapsam dar

**Soru (2026-09-15):** planlama ve QA case üretimi katmanına DeepSeek ya da
OpenAI eklenebilir mi?

**Karar: şimdilik hayır — ama şema engellemesin.** `agents.roles[*]` altına
`provider` alanı eklenir, varsayılanı `anthropic`. Uygulama gelene kadar tek
sağlayıcı koşar; alanın varlığı sonradan şema göçü gerektirmemesi içindir.

Ayrım rolün **araç ihtiyacına** göre yapılır:

| Rol | Uygunluk | Neden |
|---|---|---|
| Planner | düşük | "Plan yaz" değil, ARAÇLI KEŞİF. Ölçüldü (Collection işi): onlarca `Read`/`Grep`, referans depoda emsal arama, `CLAUDE.md`'den alıntı, `Category`'nin ölü şema olduğunu keşfetme. Ajanlık döngüsünü sıfırdan kurmak gerekir. |
| Developer | düşük | Aynı sebep + konteyner içinde yazma yetkisi. |
| QA case üretimi | **yüksek** | Girdi dar (plan + diff), çıktı yapılandırılmış (`QA_CASES_JSON`), araç ihtiyacı düşük. Üç katmanlı doğrulama zaten var: agent yazar → orkestratör sentezler → Zod doğrular. Zayıf çıktı sessizce sızmaz. |
| Analyst | orta | Tarama mekanik olarak `scan.ts`'te bitiyor; LLM yalnız profile çeviriyor. |

**Bedeli (ilk gerçek uygulamada ödenecek):**

1. Sağlayıcıya özel `AgentTransport` — araç çağrısı → dosya okuma → devam
   döngüsü dahil. `TransportRunOptions` alanları (`allowedTools`,
   `resumeSessionId`, `channel`, `askUser`, `maxTurns`) Claude Agent SDK'nın
   verdiği şeyler; düz completion API'sinde karşılıkları elle yazılır.
2. `IdentityPool` sağlayıcı ayrımı — bugün tek tip anahtar yönetiyor.
3. `detectQuota` Anthropic hata biçimine göre yazılmış; her sağlayıcının kota
   imzası ayrı. Değişmez kural 6 burada da geçerli: imza yalnız hata nesnesinde
   ve `result` mesajında aranır.
4. `cost_records` mikro-dolar tutuyor ama fiyat tablosu sağlayıcıya göre değişir.

**İlk deneme QA case üretiminde yapılmalı:** yanılma bedeli düşük ve ölçüm
kolay — aynı diff'e iki sağlayıcıdan case listesi alınıp karşılaştırılır.

Mimari ihlali yok: bu tam olarak "motor yetenek sunar, profil hangisinin
geçerli olduğunu söyler" ilkesinin uygulaması.

## 13. Referans depolar `gitUrl`den konteynere klonlanır, host'tan bağlanmaz

**Soru (2026-09-18):** Northwind'e "Contoso'daki X gibi" bir iş verildiğinde
Planner'ın Contoso'yu okuması nasıl sağlanır?

`referenceRepos` şeması zaten vardı ama uygulaması eksikti: `path` host yolu
tutuyordu, `analyst/validate.ts` bunu host'ta `existsSync` ile doğruluyordu,
`engine/job.ts` bunu Planner promptuna basıyordu — ama hiçbir yerde konteynere
MOUNT edilmiyordu. Konteyner `--cap-drop ALL` altında yalnız `docker.ts`'te
açıkça tanımlı mount'ları görür (`jobVolume`, `sourceRoot`, `resourcesRoot`,
cache'ler); tanımsız bir host yolu konteyner içinden **yoktur**, agent'ın Read
aracı da olsa "no such file" alır. Yorumdaki "agent cwd dışını okuyabiliyor,
ölçüldü" iddiası muhtemelen konteynersiz bir bağlamda doğruydu, job akışında
geçerli değildi.

**Karar: `path` → `gitUrl`.** Host'tan bind-mount YOK. Konteyner `acquire`
edilir edilmez (worktree `prepare`'den ÖNCE, `runPlanning` içinde
`cloneReferenceRepos`), her `referenceRepos` girdisi `cloneWorkspace()` ile
konteynerin KENDİ diskine, sabit bir yola klonlanır (`/references/<name>`).
`cloneWorkspace` zaten `CommandExecutor` soyutlaması üzerinden çalışıyordu
(host için yazılmıştı ama Docker'a bağlı değildi) — `ContainerExecutor` ile
aynen yeniden kullanıldı. Kimlik aynı `resolveToken()` (kural 5): ayrı bir
kimlik alanı YOK, Contoso aynı GH kimliğiyle erişilebilir olduğu için.

`isRepo()` klonu idempotent yapar: named volume kalıcı olduğu için aynı işte
ikinci `acquire` (ör. konteyner bayat token yüzünden yeniden kurulduğunda)
klonu tekrarlamaz.

**Bedeli:** host'ta ön-doğrulama artık mümkün değil (repo host'ta hiç yok) —
`validate.ts` yalnız `gitUrl` biçimini kontrol eder, erişilemez/yanlış URL
klon anında patlar ve iş `developing_failed`e düşer. Kabul edildi: profil
onayında yakalanmasa da ilk koşuda hemen görünür, sessiz yanlış plan
üretmekten (eski risk) iyidir.

## 14. Canlı ortam TAM build ister; `working_dir` canlı konteynerin köküne çevrilir

**Yaşandı (2026-09-22):** canlı ortam konteyneri "Started" dedi ama uygulama
hiç kalkmadı; hazırlık yoklaması sessizce zaman aşımını bekledi. İki
ayrı neden:

1. **`working_dir` yanlış kökteydi.** Değer `job.worktreePath` idi, yani agent
   konteynerinin kökünü (`exec.workdir`) taşıyordu; aynı volume canlı konteynerde
   `live.app.workdir`e bağlı. Kökler farklıyken Docker var olmayan dizini BOŞ
   yaratıyor ve komut orada koşuyor. `compose.override.yml`de `working_dir` elle
   `<app.workdir>/worktrees/<jobId>/<repo>` yapılınca ortam kalktı. Çeviri artık
   `liveWorkingDir` (`live/compose.ts`) içinde.
2. **Canlı ortam build çıktısına muhtaç.** Uygulama worktree'den, TAZE bir
   konteynerde başlıyor; koşullu derleme (`whenChanged`) yalnız dokunulan katmanı
   derlediği için öteki katmanın çıktısı volume'de olmayabiliyor.

**Karar:** `live.buildBeforeStart` (varsayılan açık). Açıkken canlı ortamdan
önce — ilk kalkışta ve "yeniden kaldır"da — bütün build adımları koşulsuz koşar
(`changedFiles: null`). `final-phase` ile birlikteyse build iki kez koşmaz; o tek
build koşulsuz olur. Kırmızı build ortamı kaldırmaz, son safhayı yeniden açar
(var olan `runFinalBuild` döngüsü, `maxLoops.build` tavanı).

**Profil alanı, çünkü:** uygulaması kendi imajını derleyen (`app.build`) bir
projede worktree build'i canlı ortamın ön koşulu değildir.

**Bedeli:** süre — Northwind'de tam build ~27 dk ve "yeniden kaldır" da bunu öder.

## 15. Giriş: çerez oturumu + isteğe bağlı TOTP; insan-bekleme bildirimi

**Yaşandı:** `AHTAPOT_ADMIN_TOKEN` tanımlıyken UI kullanılamıyordu. `onRequest`
kancası her isteği koruyordu — `/` de 401 JSON dönüyor, token girilecek ekran
hiç yüklenmiyordu. Tarayıcı WebSocket'i başlık gönderemediği için `/ws` her
zaman 401 alıyordu. Token `localStorage`'da, betikten okunabilir duruyordu.

**Karar:**
- Kapı yalnız `/api/*` ve `/ws`'i korur; statik kabuk, `sw.js`, manifest açık.
- Kimlik HttpOnly + `SameSite=Strict` oturum çerezinde (DB'de SHA-256 hash).
  REST ve WS aynı yoldan doğrulanır; WS'te ayrıca Origin = Host denetimi.
- Faktörler yapılandırmadan türer: token tanımlıysa birinci adım, TOTP
  bağlıysa ikinci adım. Token doğrulanınca 5 dk'lık `pending_totp` oturumu
  açılır — hiçbir API'yi açmaz. Hiç faktör yoksa sunucu açıktır; UI kırmızı
  uyarı gösterir, loopback dışında dinleniyorsa açılışta `error` log'u.
- TOTP elle (RFC 6238, SHA1/6/30 — uygulamaların GÜVENİLİR desteklediği tek
  birleşim), ±1 pencere, aynı adım ikinci kez kabul edilmez, IP başına 5
  hatada 1 dk kilit. Kurulum kodla onaylanmadan girişte sorulmaz; onayda diğer
  oturumlar kapanır; kaldırmak kod ister. Kurtarma: `AHTAPOT_RESET_2FA=1`.
- Bearer yalnız TOTP bağlı değilken geçer (betik/test); bağlıyken token tek
  başına ikinci faktörü atlatırdı.

**Bildirim:** hub'ın `emit`ine süreç içi dinleyici (`notify/notifier.ts`).
Tetik: `approval.required`, `agent.question`, `job.state=NeedsAttention` ve
Analyst taslak profili. Motorun her kapı noktasına çağrı serpiştirmek yeni kapı
eklendiğinde bildirimin unutulması demekti. Kanallar: Web Push (VAPID anahtarı
DB'de kalıcı — yeniden üretilirse tüm abonelikler sessizce ölür) ve ntfy
(HTTPS'siz kurulum için). Yük maskelenir ve kısaltılır; aynı kapı/soru için tek
bildirim.

**Neden önemli:** `askTimeoutMinutes` dolunca agent varsayımla devam ediyor —
görülmeyen soru, insanın istemediği bir kararın alınması demek.

**Issue senkronu:** issue'dan açılan iş kayıtla senkron tutulur
(`tracker/sync.ts`). Bildirimle aynı desen — hub `emit` dinleyicisi, motor
takipçiyi bilmez. Yapılanlar profilin `tracker` bölümünde (proje tercihi):
başlarken token sahibine atama, aşama etiketi (`ahtapot: Plan` … — issue
listesinde görünsün diye; durum makinesinden kaba, `Building↔Developing`
döngüsü etiket değiştirmez), geçiş notları, canlı test hazır olunca açana geri
atama + adres + süre, `Done`'da süre özeti (duvar saati / agent / insan
beklemesi), motor merge ettiyse kapatma.

- **Adaptör `job.source` ile seçilir** (`IssueTracker`): Jira/ClickUp = yeni
  adaptör, şemaya takipçiye özel alan girmez. Genel `external_url` eklendi.
- **Idempotency DB'de** (`external_sync`, `unique(job_id,key)`): uzlaştırma
  ve yeniden başlatma aynı `job.state`i tekrar yayınlıyor; bellek içi küme
  süreçle ölür ve aynı yorum iki kez düşerdi. Anahtar yalnız başarıda yazılır.
- **Dış merge izlenmez (bilinçli):** `mergeApproval` kapalıyken PR'ı insan
  GitHub'da birleştirir; kapanışı PR gövdesindeki `Closes #N` yapar. Varsayılan
  dal dışına açılan PR'da issue açık kalır — kabul edildi.
- **Rozet `/badge/jobs/:id.svg` kimliksiz:** GitHub görselleri camo vekiliyle
  çerezsiz çeker. Yalnız aşama adı döner; bilinmeyen kimliğe 404 değil gri
  rozet (varlık sızmaz). Link ve rozet `AHTAPOT_PUBLIC_URL` ister.

## 16. Emsal işe bağlıdır ve host'tan salt okunur bağlanır; `nestedRepos` kalktı

**Soru (2026-09-23):** "`X` yolundaki plugin'lere bak, onlar gibi `Y`'yi yaz"
nasıl verilir? Profil düzeyindeki `referenceRepos` her işte aynı depoyu klonlar;
emsal ise işe özgüdür, çoğu zaman bir DİZİNDİR ve host'ta durur (iç içe repo
içinde bile olabilir, remote'u olmayabilir).

**Karar:** iş açılırken `referencePaths[]` (host mutlak yolları) verilir.
`acquireRuntime` bunları agent konteynerine **salt okunur bind** olarak bağlar;
konteyner içi yeri `jobReferenceMounts` üretir (`/emsal/<son-parça>`, çakışırsa
sıra eki). Planner, triage ve Developer promptu aynı fonksiyonla hem konteyner
yolunu hem host yolunu görür, açıklamada host yolu geçse de eşleme tahmin
edilmez. Yollar iş açılınca sabitlenir: konteyner bir kez kurulur, bağlamaları
sonradan değişmez. Klonlanan iş yolları taşır.

§13 ile çelişmez: orada sorun, profilin HER işte aynı host yolunu varsaymasıydı.
Burada yolu insan o iş için açıkça veriyor. `referenceRepos` (gitUrl → klon)
profilde kalıyor.

**Bedeli:** var olmayan yol ön-doğrulanmaz (sunucu da konteynerde koşabilir,
host yolunu göremez). Docker bağlama anında "bind source path does not exist"
ile düşer ve iş `NeedsAttention`a gider. Emsal dizindeki sırlar maskelenmez;
agent onları okuyabilir (çıktı yine `scrubSecrets`ten geçer).

**`workspace.nestedRepos` kaldırıldı.** Tek işlevi `requiredForBuild` ile
içeriği worktree'ye kopyalamak ve doğrulamada "submodule mü" uyarısıydı. Emsal
için okunur erişimi artık işe bağlı bağlama sağlıyor. İç içe repoya YAZMA hiç
desteklenmiyordu: kök repo onu gitignore'ladığı için yazılan kod diff'e, commit'e
ve PR'a girmez. Eski profillerdeki alan Zod'da sessizce düşer. Tarayıcı
(`analyst/scan.ts`) iç içe repoyu hâlâ işaretler; bu, Analyst'in onu submodule
sanmaması içindir.

## 17. Issue şablonları motorun standardı; hedef repoya PR ile önerilir

**Soru (2026-09-23):** Issue'dan açılan işte gövde + yorumlar olduğu gibi
Planner'ın ilk bağlamı oluyor. Serbest metin issue'larda amaç, kabul ölçütü,
yeniden üretme adımı çoğu zaman yok; Planner boşluğu varsayımla dolduruyor.

**Karar:** Görev (`task.yml`) ve hata (`bug.yml`) issue formları +
`config.yml` (`blank_issues_enabled: false`) motorda tek kaynaktan
(`tracker/issueTemplates.ts`) gelir ve bağlanan her workspace'in reposuna
önerilir.

- **Profil alanı değil, motor standardı:** girdinin biçimi Planner'ın
  ihtiyacı, projenin tercihi değil. Üstelik bağlanma anında henüz profil yok.
  Projenin "istemiyorum" hakkı PR'ı kapatmakla kullanılır.
- **Doğrudan yazılmaz, PR açılır:** hedef repo insanındır. Varsayılan dala
  commit yok; dal `ahtapot/issue-templates` + PR. Force-push yok — PR'sız
  kalmış eski dal sıfırlanmadan yeniden kullanılır.
- **Üzerine yazılmaz:** aynı yolda dosya varsa (projenin kendi `bug.yml`'i)
  dokunulmaz; PR yalnız eksikleri taşır.
- **Kapatılan PR tekrar açılmaz:** aynı daldan kapatılmış (ya da birleşip
  sonra dosyaları silinmiş) PR varsa durum `declined`; ne otomatik akış ne
  düğme yeniden önerir.
- **Bağlanmayı bozmaz:** öneri klon bittikten (ya da dışarıdan bağlanan
  workspace'te hemen) sonra arka planda koşar; `gh` yoksa, repo GitHub değilse
  ya da yetki yetmiyorsa yalnız log'a uyarı düşer. Özellikten önce bağlanan
  workspace'ler için proje sayfasında "PR ile öner" var.
- **Boş form alanı ayıklanır:** issue formları boş isteğe bağlı alanı
  `_No response_` diye yazar; iş açıklamasına girmeden silinir.

## 18. Agent tabanını sunucu kendisi build eder; proje imajı taban değişince yenilenir

**Soru (2026-09-23):** SDK 0.3.280'e çıktı; varsayılan Opus 5.5 oldu. Sunucu
imajı güncellendi ama iş konteyneri eski CLI (2.1.270) ile koştu ve API
`400 ... version 2.1.280 or newer is required` döndü. Sebep: taban
(`ahtapot/agent-base`) ghcr'de ayrı bir paketti; deploy'da `pull` + yerel
ada `tag` ve ardından her proje imajının elle yeniden build'i gerekiyordu.
İkisi de atlandı. Oysa sunucu imajı aynı lock dosyasıyla kuruluyor — taban
aynı commit'in elle eşitlenmesi gereken bir kopyasıydı.

**Karar:** Sunucu imajı tabanın build bağlamını taşır (`docker/agent/Dockerfile`,
lock, shared + bridge `dist`). Sunucu açılışta (arka planda) ve her yeni iş
konteynerinden önce bağlamın içerik parmak izini hesaplar; `ahtapot/agent-base:latest`
bu izi taşımıyorsa build eder (`exec/agentBase.ts`).

- **Parmak izi etiket olarak yazılır** (`ahtapot.base`). `FROM` ile türeyen
  proje imajı etiketi miras alır; ayrı kayıt tutmadan "bu imaj hangi taban
  üstünde" okunur.
- **Proje imajı otomatik yeniden build edilir** (kullanıcı kararı): iş
  konteyneri kurulurken proje imajının etiketi güncel izle uyuşmuyorsa
  profilin kendi tarifiyle build edilir; iş onu bekler. Build
  `profile_image_builds`a yazılır, UI'daki imaj panelinde görünür. Tarif yoksa
  iş net bir hatayla durur ("yeniden analiz edin").
- **Yalnız yeni konteynerde:** ayakta olan konteynerin imajı değişmez.
  Sunucu güncellemesi yeniden başlatma demek; köprü oturumları düşer.
- **Profil build'i tabanı önce tazeler:** eski taban üstüne build edilen imaj
  ilk işte yeniden build edilirdi.
- **Parmak izi yalnız taban bağlamından:** tabanı değiştirmeyen sunucu
  değişikliği proje imajlarını boşuna yeniden build ettirmez.
- **Bedeli:** sunucu imajı köprü dist'i kadar büyür; taban değişen ilk
  açılışta build birkaç dakika sürer ve host daemon'ının Docker Hub, npm ve
  github.com'a çıkabilmesi gerekir. ghcr'deki `ahtapot-agent-base` paketi ve
  workflow'u kalktı.

## 19. PRReview PR'ı açar ve bot incelemesini CI'dan önce çözer

**Sorun (yaşandı, 2026-09-25):** profilde "Kod incelemesi: otomatik
(coderabbit)" görünmesine rağmen CIWatch'ta DevOps'a yalnız CI logları gitti.
İki sebep: (a) `review.provider`/`autoTrigger` motorda hiç okunmuyordu, yorum
okumayı yalnız `blocksMerge` (varsayılan kapalı) açıyordu; (b) kırmızı CI turu
botu beklemiyordu — build dakikalar içinde düşüyor, bot o sırada hâlâ
inceliyor, başlıklar boş çekiliyordu.

**Karar (kullanıcı):**
- **PRReview artık yalnız kapı değil.** QA yeşil → (profil isterse `pr_open`
  onayı) → PR açılır → `review.provider` `none` değilse botun head commit'teki
  check'i bitene kadar beklenir → eşiği aşan açık yorumları **Developer** çözer
  → push → yeniden beklenir. Sonra CIWatch; DevOps süreci aynen sürer.
- **`git.pr.openApproval`** (varsayılan açık): PR açma onayı profile bağlandı.
  Onaysız yolda da `pr_open` satırı sistem onaylı yazılır — `retry()` ve
  önceden kırık test bilgisi o satırdan okunuyor.
- **Sorma yalnız tur tavanında:** `review.maxRounds` turdan sonra yorum hâlâ
  açıksa `review_round` kapısı: "bir tur daha" ya da "CI'a geç". Kritik yorumda
  ayrı kapı yok.
- **Bot gelmezse akış durmaz:** `review.waitMinutes` dolunca eldeki yorumlarla
  sürülür. `autoTrigger` açıksa sürenin yarısında `@coderabbitai review`
  yazılır (kota dolunca bot kendiliğinden incelemiyor).
- **Developer kendi oturumunu sürdürür:** runner rol başına tek açık oturum
  tutuyor; yeni oturum Developing'in resume edeceği kimliği ezerdi.
- Kod değiştirmeden gerekçeyle cevaplanan yorum aynı girişte bir daha
  verilmez; tur değişiklik üretmezse yeni inceleme gelmeyeceği için beklenmez.

**Bilinen sınır:** `retry()` PR'lı işi doğrudan CIWatch'a götürür; inceleme
turları yeniden koşmaz.

## 20. PR'dan önce yerel ön inceleme (OpenCodeReview)

**Sorun (2026-09-26):** CodeRabbit'te her düzeltme push'u yeni bir inceleme
ve kota saatte 3 (§19'da ölçüldü). PRReview turları kotayı yakıyor, iş
"rate limited" beklemesine düşüyordu. Abonelik (30 $) sürüyor; bırakılmıyor.

**Karar (kullanıcı):** CodeRabbit'in önüne, PR AÇILMADAN, yerel bir ön filtre:
[alibaba/open-code-review](https://github.com/alibaba/open-code-review)
(Go CLI, Apache-2.0). Amaç botun yerini almak değil — bariz kusur PR'dan
önce düşsün, bot turu azalsın.

Tüm akış (PRReview'ın içinde, yeni durum YOK):

```
QA yeşil
 └─ PRReview
     ├─ [git.pr.openApproval] pr_open kapısı
     ├─ yerel ön inceleme (review.local.enabled, PR henüz yoksa)
     │   ├─ QA testleri commit'lenir
     │   └─ tur 1..maxRounds:
     │        ocr review --from <defaultBranch> --to HEAD  (iş konteynerinde)
     │        ├─ bulgu yok ──────────────► çık
     │        ├─ ocr koşamadı ───────────► çık (not düşülür)
     │        └─ bulgu var → Developer çözer → commit
     │             └─ değişiklik yok ────► çık
     ├─ PR açılır (push)
     ├─ bot incelemesi (review.provider ≠ none) — §19 döngüsü aynen
     └─ CIWatch → merge kapısı
```

- **Alt adım, durum değil (kullanıcı):** yerel inceleme ile bot incelemesi
  aynı işin — PR kalitesinin — parçası. Durum makinesi değişmedi.
- **Ön filtre akışı DURDURMAZ, kapı açmaz:** anahtar yok, araç düştü, süre
  doldu ya da tavan doldu → not düşülür, PR açılır; doğrulamayı bot yapar.
  İş yalnız Developer koşusu düşerse `fail()` olur.
- **Son düzeltmeden sonra yeniden incelenmez:** `maxRounds` hem inceleme hem
  düzeltme tavanı. Doğrulama koşusu bot zaten inceleyeceği için para yakardı.
- **Şiddet eşiği yok:** OCR şiddet yazmıyor; bulgular `severity: unknown`
  ile gider ve `minSeverity`e tabi değildir. Araç precision'a ayarlı,
  Developer yine her yorumu kodda doğrular.
- **Sağlayıcı parametrik (kullanıcı):** `protocol` (`openai`,
  `openai-responses`, `anthropic`) + `baseUrl` + `model` + `keyRef`. GPT
  (daha ucuz) ya da uyumlu bir router seçilebilir; motor değişmez.
- **Anahtar profilde değil:** profil DB'de ve UI'da. `AHTAPOT_REVIEW_KEYS`
  dosyası `ad=anahtar` satırları taşır, her koşuda okunur (döndürmek yeniden
  başlatma istemez). Claude havuzundan AYRI: havuz anahtarları `sk-ant-oat`
  önekine göre sınıflıyor; OpenAI anahtarı yanlış tipe düşerdi.
- **Konteynerde koşar, anahtar exec başına:** worktree named volume'de,
  sunucu dosyalara erişemiyor (§11). Anahtar `docker exec`in ortamına girer,
  konteynerin kalıcı ortamına değil — köprünün `identity.set`iyle aynı ilke.
  O sırada Developer koşmuyor; aynı konteynerde anahtarı görebilecek başka
  süreç yok.
- **`HOME` geçici dizin:** OCR `~/.opencodereview/config.json`u ortam
  değişkenlerinden ÖNCE okuyor; kalmış bir dosya profilin seçtiği sağlayıcıyı
  sessizce ezerdi.
- **`retry()`:** PR henüz açılmamış ve yerel inceleme açıksa iş CIWatch'a
  değil PRReview'a döner; tur sayacı (`loopCounts.local_review`) kaldığı
  yerden sürer. CIWatch yolu PR'ı incelenmemiş kodla açardı.

**Ölçülenler (2026-09-26, v1.12.9):**
- Araç git ≥ 2.41 istiyor; bookworm 2.39 taşıyor, backports'ta yok. Kontrol
  yalnız UYARI basıyor; dosya seçimi (`--preview`) 2.39'da doğru çalıştı.
  Taban dağıtımı değiştirilmedi — proje imajları onun üstünde.
- Belgelenmemiş: tüm alt ajanlar düşünce `status: "failed"`, `comments: null`
  ve çıkış 1. Şema ikisini de kabul eder; `failed` "temiz" sayılmaz.
- Sahte uç noktaya karşı koşuda anahtar ne stdout'a ne stderr'e yazıldı.
- Gerçek koşu (gpt-6-sol, üç kusur bırakılmış deneme deposu): üçü de doğru
  satırda bulundu; 9.4k token, 13 sn (~0,02 $). `status` belgedeki `success`
  değil, manifest'in `terminal_state`i: `complete`/`partial`/`failed`/`skipped`.
- GPT-6 Chat Completions'ta OCR'ın `max_tokens`ı ve `temperature: 0`ı 400
  ile reddediyor; resmî OpenAI için protokol `openai-responses`.

**Bilinen sınırlar:**
- Maliyet `cost_records`a yazılmıyor: fiyat tablosu sağlayıcıya göre değişir
  (§12 madde 4). Token sayısı nota düşülür; tavan `maxTokensBudget`.
- Delegation modu (OCR yalnız dosya seçer, incelemeyi bizim agent yapar)
  uygulanmadı: OCR'ın asıl değeri olan konumlama/yansıtma modüllerini
  kaybettiriyor. Abonelik token'ıyla koşmak gerekirse ayrı karar.

## 21. Canlı test senaryoları isteğe bağlı, ayrı rol, durum değiştirmez

**Sorun (insan talebi, 2026-09-26):** Canlı testte insan uygulamayı porttan
deniyor ama elinde geliştirilen koda özgü bir senaryo listesi yok. QA case'leri
otomatik teste dönüşmek için var ve canlı test onayından SONRA üretiliyor.

**Karar:**
- Senaryo bir **kapı değil, düğme**: plan kapısında ya da canlı test kapısında
  insan ister. Her işte gerekmiyor; kapı yapmak her işe bir tıklama bindirirdi.
  Motor yetenek sunar — profil alanı gerekmedi.
- **Durum değişmez, faz da değişmez.** `running` yazılsaydı yeniden başlatmada
  `reconcile` bekleyen kapısı olan işi yarıda kalmış sayıp NeedsAttention'a
  alırdı. Sahipsiz `running` satırı açılışta `failed` olur.
- **`busy` işaretlenir:** köprü konteyner başına tek koşu alıyor; üretim
  sürerken verilen bir onay Developer'ı başlatsa köprü onu "busy" ile reddeder
  ve iş boşuna düşerdi. Bedeli: üretim süresince onay/sohbet bekler.
- **Ayrı `tester` rolü**, `qa` değil: oturum rol başına tutuluyor; `qa` ile
  koşsaydı QA'nın sonraki case turu plan anındaki eski oturumu sürdürürdü.
  Model yapılandırması yoksa `qa` rolününkine düşer. Köprüye kablo üzerinde
  `qa` diye gider — köprü rolü kullanmıyor, ama imajı tazelenmemiş eski köprü
  yeni rolü şemada reddedip koşuyu asılı bırakırdı.
- Senaryo üretilemezse iş NeedsAttention'a düşmez (triage gibi danışman).
- Son hazır liste QA case prompt'una **aday** olarak girer, bağlayıcı değil.
- **İşaretler sunucuda** (migration 0014, `test_scenarios.marks` + `round`),
  yerel değil (insan talebi, 2026-09-26): canlı test reddinde "kaldı"lar
  adımları, beklenen sonucu ve insanın notuyla Developer'a gitmeliydi; insan
  bunları yoruma elle yapıştırıyordu. Her turda listeyi yeniden üretmek de
  yanlış — liste turlar boyunca aynı satırda sürer.
- Red anında taşıma: gönderilen "kaldı" → `retest`; **aynı alandaki** "geçti"
  → `retest` (düzeltme o ekrana dokundu, eski "geçti" kanıt değil); diğer
  "geçti"ler "önceki tur" olarak kalır. Alanı boş senaryolar eşleşmeye girmez —
  "Genel" her şeyi sıfırlardı. Diff'ten etkilenen senaryoyu çıkarmak mümkün
  ama tahmin; alan eşleşmesi insanın görebildiği, açıklanabilir bir kural.
- Dördüncü işaret **kararsız** (nadir): sonuç tutarsız ya da senaryonun
  kendisi yanlış (yanlış alarm). Developer'a gitmez, turlar arasında
  sıfırlanmaz; notu nedenini taşır.
- "Kaldı" varsa red yorumu zorunlu değil. İşaret yalnız LiveTest'te konur;
  senaryo başına ayrı `PUT` — iki sekmenin tüm listeyi ezmemesi için.

## 22. Takılan işte model insanın elinde: iş başına seviye zorlaması

**Sorun (insan talebi, 2026-09-26):** Döngüye girip tavanda düşen iş —
özellikle CI'da CodeRabbit yorumları ve kırık testler — Sonnet ile
çözülemiyor; "Yeniden dene" aynı modelle aynı yerde takılıyor.

**Karar:**
- `jobs.model_tier` (migration 0013): insanın seçtiği **seviye**
  (`cheap|standard|deep|frontier`), model adı değil. Kullanım anında profilin
  `agents.triage.ladder`ından çözülür — `rungFor` değil, doğrudan basamak:
  eksik basamakta `rungFor` sessizce başka modele düşerdi. Merdiven triage
  kapalıyken de varsayılanlarıyla dolu.
- Öncelik: zorlama > safha seviyesi > postplan triage > profil rolü > sabit.
  Planner, Developer (inceleme yorumu çözümü dahil), QA ve DevOps (CI,
  çakışma) uyar. Triage, `tester` ve PR başlığı yazımı uymaz — ucuz, takılan
  işler değil.
- Zorlama **iş boyunca** kalır: DevOps CI'ı düzeltince bot yeni yorum
  açabilir, onu da aynı güçte model çözmeli. "Profil" seçimi kaldırır.
- Seviye seçilerek yeniden denenirse **döngü sayaçları sıfırlanır**: tavan
  eski modelin denemeleriyle doldu; yenisi ilk kırmızıda düşmemeli.
- Nereden: "Modelle dene…" (NeedsAttention), "Yeniden aç" diyaloğu, "bir tur
  daha" (`review_round`) kapısında seçici — o sonuncusu `POST
  /api/jobs/:id/model-tier` ile kapıyı kapatmadan kaydeder.
- `approvalRequiredFrom` ayrıca sorulmaz: seçimi insan yapıyor; iz audit'te
  (`job.model_tier`) ve akışta not olarak.

## 23. Özel paket kaynağı (npm + NuGet): kaynak profilde, token sunucuda

**Sorun:** Hedef proje özel registry'den (GitHub Packages, Azure Artifacts…)
paket çekiyorsa `npm ci` auth token + scope eşlemesi ister. Profil DB'de
saklanır ve UI'da gösterilir; token oraya yazılamaz (kural 4).

**Karar:**
- `exec.registries[]`, `kind: "npm" | "nuget"` (varsayılan `npm`; alan eklenmeden
  önceki kayıtlar bozulmaz). `tokenEnv` token'ın okunacağı **sunucu ortam
  değişkeninin adı**dır, değeri değil.
  - npm: `scope?` + `url`. `scope` boşsa registry varsayılan olur.
  - NuGet: `source` (reponun `nuget.config`indeki kaynak ADI) + `username`.
    Kimlik `NuGetPackageSourceCredentials_<source>` ortam değişkeniyle gider;
    dotnet restore okur. nuget.config'e parola yazılmaz (Linux'ta şifrelenemez,
    düz metin kalırdı) ve motor o dosyaya dokunmaz — kaynak repoda tanımlı olmalı.
- `build/registryAuth.ts` yürütücüyü sarar (`runtime.ts`, `acquire` ve `attach`):
  `setup`, `build.preSteps`/`steps` ve test komutları aynı kimliği görür. Her
  komuttan önce `/tmp/ahtapot-npmrc` yazılır ve `NPM_CONFIG_USERCONFIG` ona
  gösterilir; token yalnız o `exec`in env'inde yaşar (kural 5).
- Dosya **sır içermez**, `${TOKEN_ENV}` referansı taşır. `npm_config_//host/:_authToken`
  env anahtarı kullanılmadı: npm 6'da (Node 12) anahtar küçültülüp `_` → `-`
  yapıldığı için çalışmaz.
- Çıktıdaki token değeri birebir `***` yapılır; `scrubSecrets` npm token
  biçimini tanımaz.
- `project validate`: `tokenEnv` sunucuda tanımsızsa **hata** (iş saatler sonra
  401 ile düşmesin). Değer asla gösterilmez.
- Konteyner kimliği (kural 5) değişmedi: registry token'ı Claude anahtarından
  ayrı bir sırdır ve yalnız komut `exec`ine verilir, agent'ın ortamına değil.

## 24. İnceleme/CI döngüsü: PR'a gerçek taban, kapsam çıpası, toplam bütçe

**Olay (Northwind#184):** sol ray ikonu işi 11 commit ve 30 dosyalık bir PR oldu;
yarısı konu dışı (Redis/ES önekleri, telefon regex'i, migration'lar, `run.sh`,
`ci.yml`, `yarn.lock`). CodeRabbit uyardı: döngü kendini besliyordu.

**Kök neden:** `pullBase()` uzak `main`i dala merge eder ama yerel `main`
referansını ilerletmez (mirror'ın kaynağı kullanıcının checkout'u). Yerel
inceleme `ocr review --from main --to HEAD` koşuyordu; `changedFiles`
(`main...HEAD`) ve handoff'lar da aynı bayat referansı kullanıyordu. Başkalarının
commit'leri "bu işin değişikliği" sayıldı, bulguları Developer'a gitti, Developer
başkasının kodunu düzeltti, bot yeni yüzeye yeni yorum yazdı.

**Karar:**
- `jobs.base_sha`: `pullBase()` merge ettiği uzak ucu yazar; tüm diff/inceleme
  `diffBase()` ile onu kullanır. Kayıt yoksa eski davranış (yerel taban).
- Kapsam çıpası: düzeltme prompt'una PR'ın dosya listesi ve "listenin dışına
  dokunma" kuralı girer. PR dosyaları dışındaki inceleme yorumları düzeltilmez,
  `reviewUnfixed`/merge kapısında insana görünür kalır.
- `workflow.maxFixPushes` (varsayılan 6): yerel inceleme + bot yorumları + CI
  düzeltmelerinin TOPLAM commit tavanı. Ayrı tavanların toplamı sınırsızdı. Dolunca
  iş düşmez, kalanlar kapıda insana kalır; insanın verdiği "bir tur daha" tavanı
  aşabilir.

- **Ek (2026-10-05):** kapsam süzgeci yerel incelemede (OCR) yoktu. Aralık
  doğru olsa da OCR bağlam için okuduğu dosyalara da bulgu yazıyor; bunlar
  Developer'a gidip tur yakıyordu. Artık OCR bulguları da `splitByScope`tan
  geçer; PR dışı olanlar yalnız sayı olarak bildirilir. Taban kaydı yoksa
  (yerel dala düşüldü) inceleme notunda uyarı görünür.

**Bilinçli yapılmadı:** tur sonrası "dosya listesi büyüdü mü" yakınsama denetimi
ve bot/yerel inceleme eşik ayarı (profil tercihi, Northwind'de karar).

## 25. Safha kapısında sıradaki safhanın modeli

**Sorun (insan talebi, 2026-10-05):** 48 safhalı bir planda her safha onaya
çıkıyor ama model kararı yalnız plan kapısında verilebiliyordu (`perPhase`
tablosu) ya da iş geneli zorlamayla (§22, tüm roller). Fable seçilince günlük
kota planın ortasında eriyor; insanın "bundan sonrası Sonnet'le" diyebileceği
yer her safhada zaten durduğu kapıydı. Kapıda sıradaki safhanın ne olduğu da
görünmüyordu.

**Karar:**
- Önizleme kapı yüküne gömülmez, `GET /api/jobs/:id/next-phase` ile istekle
  hesaplanır: kapı açıkken model değişebiliyor, yük bayatlardı. Model
  `developerPick` ile çözülür — `runDeveloping` de aynısını çağırır, ekranda
  görülen ile koşan ayrışmaz. Kaynak (`forced|phase|postplan|role`) gösterilir:
  zorlama varken safha seçimi etkisizdir ve insan bunu görmeli.
- `overridePhaseTiers` safha kapısında da geçer, yalnız `pending` safhalara.
  Kapsam "yalnız bu safha" ya da "kalanların hepsi" (aynı uç, çok satır).
- **İnsanın safha seçimi ayardan bağımsız geçerli:** `perPhase` kapalıyken de
  okunur ve ölçümsüz safhaya da verilebilir (safha kapısında). "Ayar
  kapatılınca kayıt susar" motorun ölçümü içindir. İnsan seçimi onayın
  kendisidir (§22); plan onayı ayrıca aranmaz. Geri alma ölçümsüz safhayı
  seviyesiz (iş geneli) hâline döndürür. Yeniden planlamada başlıkla taşınır.
- İş geneli zorlamadan farkı: yalnız Developer'ı etkiler, safha safha geri
  alınabilir. Kartta zorlamayı kaldırma düğmesi var.

**Bilinçli yapılmadı:** kapıdaki safhanın KENDİ modelini değiştirmek (red
onu aynı seviyeyle yeniden koşturur). İstenirse `awaiting_approval` da kabul
edilebilir; şimdilik kapsam "sıradaki".

## 26. İnceleme/CI düzeltmesi commit'ten önce yerelde doğrulanır

**Sorun (Northwind, 2026-10-05):** uzak sunucu derlemiyor. Yerel inceleme ve
CodeRabbit düzeltmeleri doğrudan commit'lenip push'lanıyordu; Developer'ın
düzeltme araçlarında derleme/test komutu yok, motor da koşturmuyordu. Kırık
düzeltme PR'a giriyor, CIWatch onu yakalayamıyordu.

**Karar:**
- `workflow.verifyFixes` (`build-test` | `build` | `none`, varsayılan
  `build-test`). Ölçüm orkestratörde: derleme kapısı + `runAt: "qa"` takımları;
  baseline commit'lenmemiş düzeltme stash'lenerek HEAD'de ölçülür, önceden kırık
  test düzeltmeyi kırmızıya çekmez.
- Tek nokta `runDevOps`: üç düzeltme yolu (yerel inceleme, bot yorumu, CI) aynı
  commit'ten geçiyor.
- Kırmızı → aynı oturuma `<feedback>`, düzeltme başına `limits.maxLoops.build`
  deneme (işin `build` sayacı yakılmaz). Tavanda düzeltme stash'e alınır, iş
  düşmez: yerel incelemede PR düzeltmesiz açılır (kod QA'da yeşildi), PR
  incelemesinde yorumlar "ele alındı" sayılmaz ve `review_round` kapısı açılır.

**Bilinçli yapılmadı:** uzak CI yokken CIWatch'ı atlamak (ayrı profil kararı).

## 27. Workspace release: Action tetiklenir, zamanlama Ahtapot'ta

**Sorun:** hedef projenin sürümü ve yayını Ahtapot'un dışındaydı; merge edilen
işler elle, düzensiz yayınlanıyordu. Projeler release'i farklı kuruyor
(semantic-release, release-please, elle tag, imaj yayını) — motorun bunlardan
birini yeniden yazması hem gereksiz hem proje-agnostikliği bozar.

**Karar:**
- Release'in kendisi hedef repodaki GitHub Action'ında kalır. Ahtapot yalnız
  `workflow_dispatch` ile tetikler; girdilerin adları (`bumpInput`,
  `versionInput`, `extraInputs`) profilde (`release` bölümü, varsayılan kapalı).
- Sürümün kaynağı git tag'i (`tagPattern`). Dosya (package.json, csproj) çok
  paketli repolarda tek değil. `versionInput` verilmezse Ahtapot'un hesapladığı
  sürüm yalnız tahmin; doğrulanan sürüm koşu bitince oluşan tag'den okunur.
- Akıllı kısım zamanlama: haftalık/aylık yuva, saat dilimli, sabit takvim
  (profil onayına göre kaymaz). Tur, son tag'den beri commit yoksa
  (`skipIfNoChanges`) ve dal ucunda CI kırmızı/sürüyorsa (`requireGreenCi`)
  atlanır; hiç check olmayan repo geçer. `auto` bump: `feat` → minor,
  `!`/`BREAKING CHANGE` → major, kalan patch.
- Kaçırılan yuvalardan yalnız sonuncusu yakalanır; profil onayından önceki yuva
  tetiklenmez. (proje, yuva) unique: dispatch ile sonuç yazımı arasında süreç
  ölürse kayıt `unknown` olur ve yuva harcanmıştır — ikinci yayın riski,
  kaçırılmış bir yayından pahalı.
- `gh workflow run` koşu kimliği dönmüyor. `workflow.correlationInput`
  verilirse yayın kimliği o input'la geçer ve koşu `run-name`deki kimlikle
  KESİN eşlenir. Verilmezse geri dönüş: `workflow_dispatch` olayı, dal ve
  dispatch anı (±15 sn); pencerede birden çok aday varsa `unknown` — yanlış
  koşuyu izlemek yerine. Koşular sayfalı ve `since` süzgeçli okunur.
- Uçuş denetimi ile `starting` rezervasyonu tek `BEGIN IMMEDIATE`
  transaction'ında: aynı DB'yi açan ikinci süreç arada ikinci yayın açamaz.
- Duraklatma profil DEĞİL (`projects.release_paused_until`): "bu hafta
  yayınlama" çalışma zamanı kararı, profil sürümü ve onay istememeli.
- Tetik yalnız insan (REST) ve takvim. DevOps agent'ında `gh run *` ve `gh api`
  açık olduğu için `gh workflow run` ve `dispatches` ucu ayrıca reddedilir;
  analist release'i önerir ama `enabled` daima `false` yazılır.
- Serbest cron yok: bağımlılık yok, yaz saati/cron ifadesini elle yazmak hata
  kaynağı; haftalık/aylık ihtiyacı karşılıyor.

**Bilinçli yapılmadı:** sürüm izleme ekranı (güncel sürüm rozeti, işin hangi
sürümde yayınlandığı) — aynı `listTags` üstüne ikinci aşama. İşin Done'ında
otomatik yayın — yayın işten bağımsız, takvim ya da insan kararı.

## 28. Kaynak workspace uzaktaki varsayılan dala ilerletilir

**Sorun:** mirror kaynaktan, iş dalı mirror'dan açılıyor; kaynağa ise hiç
dokunulmuyordu. Uzak sunucuda kaynak `gitUrl`den bir kez klonlanmıştı ve bir
daha çekilmedi (YAŞANDI 2026-10-06: Planner'ın planda adını verdiği dosya
ağaçta yoktu). `pullBase` yalnız birincil repoyu ve yalnız iş dalını
düzeltiyordu; ikincil repolar, gitignore'lu kopyalar ve mirror bayat kalıyordu.

**Karar:** iş ağacı kurulmadan önce ve PR merge edildikten sonra kaynak
workspace'teki her repo `origin/<defaultBranch>`e **fast-forward** edilir
(`workspace/sourceSync.ts`, host yürütücüsüyle). Yalnız repo varsayılan
dalındaysa; yerel commit ya da çakışan yerel değişiklik varsa git reddeder,
repo olduğu gibi kalır ve işe UYARI notu düşülür. Senkron işi asla durdurmaz.

Yıkıcı olmadığı için profil alanı yok: yerel geliştirmede kaynak kullanıcının
kendi checkout'u olsa da ff-only onun işini ezmez. "Kaynağa dokunulmaz" ilkesi
`WorktreeManager` için geçerli kalır — o hâlâ yalnız okur.

## 29. Statik analiz yerel incelemede, OCR'dan önce

**Bağlam:** Northwind'de SAST (OpenGrep, `.opengrep/rules`) ve DAST
(Schemathesis + ZAP) yalnız gece koşuyor (`nightly.yml`), PR'ı bloklamıyor;
C# analizörleri (Roslynator + CA) ve `dotnet format` yalnız CI'da. Ahtapot
bunların hiçbirini görmüyordu: Developer'ın ürettiği kusur gece raporuna
düştüğünde kod çoktan merge'lenmişti.

**Karar:** `workflow.review.static` — profildeki komutlar iş konteynerinde
koşar, rapor (`sarif` · `dotnet-format` · `msbuild-log`) `ReviewThread`e
çevrilir ve OCR'la aynı yoldan (`runDevOps`, `verifyFix`) Developer'a gider.
Araçlar, komutlar ve eşikler profilin; her araç ayrı açılıp kapanır
(`steps[].enabled`). Motor yalnız rapor okumayı bilir.

- **OCR'dan önce:** deterministik ve anahtarsız; ucuz bulguyu LLM'e para
  ödeyerek buldurmanın anlamı yok, OCR temizlenmiş kodu görür.
- **Satır kapsamı varsayılan:** Northwind'de yüzlerce eski uyarı var (RCS1189 63,
  CA1305 35); dosya düzeyi eski borcu Developer'a yükler. Satır farkı
  alınamazsa dosya düzeyine düşülür.
- **`msbuild-log`, SARIF değil:** Roslyn `ErrorLog` çözüm derlemesinde her
  projenin raporunu aynı dosyaya ezer. Analizör adımı `--no-incremental`
  ister — artımlı derleme derlenmemiş projelerin uyarısını basmaz.
- **Otomatik düzeltici (`fix`):** biçim kusurunu LLM'e düzelttirmek yerine
  motor profildeki `fix` komutunu (ör. `dotnet format`) koşar ve ayrı
  commit'ler (`style`). Düzelticinin PR dosyaları dışındaki değişikliği geri
  alınır; kalan değişiklik `verifyFix`ten geçmezse o da geri alınır, commit
  atılmaz. Doğrulama `workflow.verifyFixes`e göre: `build-test` derleme +
  test, `build` yalnız derleme, `none` doğrulamasız.
- **Yeniden deneme:** statik analiz açıksa `retry()` da PR öncesi zincire
  döner — yalnız OCR'a bakılırsa PR analizsiz açılırdı.
- **Rapor worktree dışında** (`/tmp/ahtapot-static`): içeride kalırsa commit'e
  girer, sır kuralları raporun kendisini tarar (Northwind nightly'de yaşandı).
- **Susturma yasak:** Developer'a `#pragma`, `nosemgrep`, `.editorconfig`
  değişikliği yasaklanır; yanlış pozitif gerekçeyle reddedilir.
- **Kapı yok:** araç düşerse ya da tavan dolarsa PR açılır. Son düzeltmeden
  sonra bir kez daha koşar ve kalanı bildirir.

DAST ayrı (LiveTest'te, canlı ortam yalnız orada ayakta) — §30.

## 30. DAST LiveTest'te, kapı açılmadan önce

**Bağlam:** Northwind'in gece DAST'ı (ZAP baseline + Schemathesis) uygulamayı
kendi kaldırıyor. Ahtapot'ta canlı ortam zaten her iş için kalkıyor ama yalnız
LiveTest'te ayakta; başka bir aşamada DAST ortamı ikinci kez kaldırmak demekti.

**Karar:** `live.dast` — ortam hazır olunca, `live_test` kapısı açılmadan
önce profildeki tarayıcı adımları sunucudan `docker run` ile, canlı ortamın
**iç ağında** ayrı konteynerlerde koşar (`live/dast.ts`). Her adım ayrı açılıp
kapanır; rapor biçimleri `zap-json` · `junit` · `sarif`.

- **İç ağ:** ağ `internal` (`allowEgress:false`) — tarayıcı yalnız uygulamayı
  görür. Bedeli: imaj içeriden çekilemez, sunucu önceden çeker.
- **Adımlar arası volume, bind değil:** sunucu konteynerde koşarken bind
  mount HOST yolu isterdi. `$OUT` ortak dizin (ör. token adımı → tarayıcılar).
- **Ağ adı etiketten:** compose ağ adına proje öneki ekliyor; tahmin edilmez.
- **Bulgular:** kapıda insana (risk sayıları + liste). İnsan reddederse eşik
  (`minRisk`) üstü bulgular geri bildirime motor tarafından eklenir.
  `autoFix` açıksa kapı açılmadan düzeltme safhası açılır — insanın reddiyle
  aynı yol ve aynı `maxLoops.live` tavanı; tavanda kapı açılır.
- **Varsayılan `autoFix:false`:** Northwind'de DAST bugün yalnız rapor; gürültü
  ölçülmeden Developer'ı tura sokmak bütçe yakar.
- **Ön filtre:** tarayıcı düşerse kapı yine açılır; hiçbir rapor okunamadıysa
  "temiz" değil "sonuç yok" gösterilir.
- **Kapsam dalın uçları (insan talebi, 2026-10-12):** tarif sabit olduğu
  için her iş aynı uçlara saldırıyordu; işin eklediği/değiştirdiği uç gece
  taramasından farksız kalıyordu. `live.dast.scope`: motor tabana
  (`baseSha`) göre değişen dosyalarda profilin `routePattern` regex'iyle
  rota arar, adıma `DAST_SCOPE`, `TARGET_PATHS`, `TARGET_PATH_REGEX`,
  `$OUT/targets.txt`, `$OUT/changed-files.txt` verir. Uçları agent değil
  motor çıkarır (kural 3); rota biçimi projenin tercihi olduğu için regex
  profilde. Uç bulunamazsa `whenEmpty`: `full` (tam tarama, varsayılan) ya
  da `skip`. Daraltmayı kullanmak tarayıcı komutunun işi (ör. Schemathesis
  `--include-path-regex "$TARGET_PATH_REGEX"`); kapı neyin tarandığını gösterir.
  Komutları ve `routePattern`ı workspace analisti çıkarır (`analyst.md`
  "DAST"): projenin DAST tarifini adımlara çevirirken komutları
  `DAST_SCOPE`a göre dallandırır, regex'i kodda deneyip gerekçeye yazar.

## 31. PR öncesi sıra: güvenlik → kapı → kod kalitesi (MegaLinter)

**Bağlam:** Kullanıcı isteği: PR açılmadan önce SAST ve DAST tamamlanmalı,
ardından MegaLinter okunabilirliği denetlemeli — güvenlik düzeltmelerinin
dokunduğu dosyalar da dahil. §29'da tüm statik adımlar tek turda koşuyordu ve
kalan bulgu PR'ı durdurmuyordu.

**Karar:**
- Statik adımlara `category` (`security` | `quality`). Önce `security`
  turları, sonra `quality` turları koşar; kalite PR'ın TÜM dosyalarına
  bakar, güvenlik düzeltme commit'leri de diff'te olduğu için denetlenir.
  Sayaçlar ayrı: `static_review`, `quality_review`.
- `securityGate` (profilde, varsayılan kapalı): güvenlik turları bittiğinde
  bulgu kaldıysa ya da bir güvenlik aracı koşamadıysa `security` kapısı
  açılır. Onay → bir güvenlik turu daha (not Developer'a), red → kalanlarla
  kaliteye ve PR'a. Koşamayan araç "temiz" sayılmaz — kapıda ayrıca görünür.
- DAST bu kapıya girmez: DAST yalnız canlı ortamda doğrulanabilir; PRReview'da
  "bir tur daha" düzeltmeyi yeniden tarayamaz ve kapı kendini tekrar açardı.
  DAST'ın insan kararı `live_test` kapısında (§30), o da PR'dan önce.
- `image` alanı: MegaLinter gibi GB'lık araçlar iş imajına kurulmaz; sunucu
  ayrı bir konteyner kaldırır, iş volume'ünü AYNI yola bağlar (worktree yolu
  iki tarafta aynı), iş konteynerinin `uid:gid`iyle koşturur (root'un yazdığı
  dosyayı iş konteyneri commit'leyemez). Rapor volume'de worktree dışında
  (`<exec.workdir>/.ahtapot-static/`).
- Yeniden denemede (`retry`) statik analiz açıksa PR öncesi zincir baştan
  değil kaldığı turdan sürer (§29'da yalnız OCR'a bakılıyordu — kusurdu).

MegaLinter'da C# linter'ları kapalı tutulur: Roslynator/CA/`dotnet format`
zaten `quality` adımı; aynı bulgu iki kez Developer'a gitmesin.

## 32. PR öncesi `main` senkronu: merge, taban ilerler, çözüm derlenir

**Sorun:** `pullBase()` uzak `main`i yalnız işin başında çekiyordu. LiveTest ve
QA insanı beklediği için saatler-günler sürüyor, `main` bu arada ilerliyor.
Çakışma ancak PR açıldıktan sonra `syncBase()`te görünüyordu: bot inceleme
kotası çakışma push'una gidiyor, statik analiz ve yerel inceleme PR'a gidecek
son diff'i görmüyordu.

**Karar (kullanıcıyla, 2026-10-09):** PRReview'ın başında, PR henüz yokken
uzak `defaultBranch` dala merge edilir (`workflow.syncBaseBeforePr`,
varsayılan açık). Sıra: merge → (çakışma varsa) derleme → statik analiz →
yerel inceleme → PR.
- **Merge, rebase değil:** PR squash ile birleşiyor; rebase'in tek kazancı
  olan doğrusal geçmiş `main`e zaten tek commit olarak iner, merge commit'i
  iz bırakmaz. Squash rebase'in maliyetini ise değiştirmez: rebase dalın
  commit'lerini tek tek yeni tabana yeniden oynatır, çakışma commit başına
  çıkar (safhalı işte agent N tur çözer); SHA'lar değişir, dal daha önce
  push'lanmışsa (PR açılırken düşen yeniden deneme) force-push gerekir —
  yasak. Merge'de çakışma tek turdur.
- **LiveTest'te değil:** insan çalışan ortamı test ederken merge ortamı
  yeniden kurdurur; LiveTest/QA uzun sürerse `main` yine ilerler.
- **Uzak `main` incelenmiş ve test edilmiş sayılır:** `baseSha` çekilen uca
  ilerler; yerel inceleme ve kapsam çıpası yalnız işin değişikliğini ve
  çakışma çözümlerini görür. Taban eski kalsaydı §24'teki şişme geri gelirdi.
- **Çakışmasız merge doğrulanmaz:** birleşimi CI sınar.
- **Agent çakışma çözdüyse derleme kapısı koşar:** iki taraf da tek başına
  geçse de elle birleşim derlenmeyebilir (yeniden adlandırılmış metot,
  kaybolan alan). Kırmızıysa merge geri alınır, iş `merge_conflict` ile
  düşer; yeniden deneme merge'ü ve çözümü baştan yapar. Testler yine CI'da.
- **`maxFixPushes`ten düşmez:** senkron bir düzeltme değil.
- Çakışma çözümü `syncBase` ile ortak (`mergeFetched` + `resolveConflicts`);
  PR açıkken ilerleyen `main` için `syncBase` güvenlik ağı olarak kalır.

## 33. Mentor: takılan agent bir üst basamağa danışır, takıldığını motor anlar

**Sorun (insan talebi, 2026-10-09):** Agent'lar döngüye giriyor ve bunu
kendileri söylemiyor. Gözlenen: özellikle canlı test (preview) ve CI
oturumlarında aynı dosya defalarca okunuyor, tur ve bütçe ilerleme olmadan
yanıyor. Bugünkü çıkışlar pahalı ya da geç: tavana kadar dönüp
NeedsAttention'a düşmek, sonra insanın §22 ile bütün işi daha güçlü modele
zorlaması. Oysa çoğu zaman tek bir soruyu bir üst modelin cevaplaması yeter.

**Karar:**

- **Takıldığını motor anlar, agent değil.** Rol promptuna "takılırsan sor"
  yazmak yetmez; LLM döngüde olduğunu kabul etmiyor. Runner zaten her
  `tool_use`yu kesilmemiş girdisiyle, her `tool_result`ı da sonucuyla görüyor
  (`agents/runner.ts`). Tespit orada, saf bir fonksiyonla yapılır
  (`agents/stuck.ts`: olay → sinyal). Sinyal agent'ın metninden ÇIKARILMAZ,
  davranışından çıkarılır (Kural 6 ile aynı gerekçe).
- **İlk sinyaller (ölçülmüş olanlar önce):**
  - `repeat_read`: aynı `(yol, offset, limit)` üçlüsü arada o yola yazma
    (`Edit`/`Write`/`MultiEdit`, ya da yolu geçen bir `Bash`) olmadan
    `N` kez okundu. Arada yazma varsa yeniden okuma meşrudur, sayaç sıfırlanır.
    Farklı `offset` ile sayfalama döngü değildir. Aynı desen ve yolla
    tekrarlanan `Grep`/`Glob` da buraya sayılır. Salt okunur Planner'ın
    döngüsü bu şekilde görünür.
  - `repeat_failure`: aynı normalize komut (boşluklar sıkıştırılmış) aynı hata
    imzasıyla `N` kez kırmızı döndü. İmza: sonucun son satırları, sayılar ve
    yollar atılmış hâliyle. Hata DEĞİŞİYORSA ilerleme var demektir (dotnet
    build'de bir hata çözülüp sıradakine geçmek), sinyal üretmez.
  - `no_progress`: `M` araç çağrısı boyunca worktree'ye hiç yazılmadı
    (yalnız yazma beklenen rollerde: Developer, QA, DevOps).
  Eşikler profilde. Yeni sinyal ancak gerçek bir işte görülen bir döngüden
  doğar.
- **Mentor = işin bu koşuda çözülmüş seviyesinin bir üst basamağı.** Safha
  planlanırken seçilen seviye (`developerPick`, §25) koşunun seviyesidir.
  Zorlama (§22), rol ya da sabit modelde seviye, model adının
  `triage.ladder`daki karşılığından bulunur. Karşılığı yoksa mentor da yoktur.
  Mentor `rungFor` ile DEĞİL, doğrudan basamakla çözülür (§22 gerekçesi).
  Bir üst basamak tanımsızsa daha yukarısı denenir.
- **Kapsam: tüm safhalar ve seviyesi olan roller.** Planner, Developer
  (inceleme ve statik düzeltmeleri dahil), QA, `tester`, DevOps, triage.
  Planner da dahil (insan kararı, 2026-10-09): yazmadığı için döngüsü
  dosyaya zarar vermez, ama tur ve bütçe yakar ve planın kalitesini düşürür.
  Takıldığında doğrudan üst modele sorar. Soru dosyasında safha yerine işin
  tanımı ve o ana kadarki plan taslağı (varsa) bulunur. Analyst yok (iş dışı,
  tek seferlik).
- **Tavan:** `agents.mentor.maxTier` (varsayılan `triage.maxTier`) mentorun
  çıkabileceği en üst basamaktır. Frontier (Fable) mentor da insan onayı
  İSTEMEZ (insan kararı, 2026-10-09). `approvalRequiredFrom` işin
  seviyesini, yani bütün oturumun hangi modelle koşacağını korur. Danışma
  ise `maxBudgetUsd` ile sınırlı tek bir cevaptır ve kodu kendisi
  değiştirmez. Önerinin doğru olup olmadığı zaten build, test ve insan
  kapılarında ortaya çıkar. Profil isterse `mentor.maxTier` ile mentoru
  aşağı çekebilir.
  En üst basamaktaki agent'ın (ya da tavana dayanmışın) mentoru insandır.
  Sinyal `ask_user` ile değil bir `agent.notice` ile bildirilir, iş kendi
  bildiği gibi sürer.
- **Mentor araçsız koşar; dosyayı motor verir.** Köprü konteynerde aynı anda
  tek koşu taşıyor (`bridge/main.ts`: ikinci `run.start` → `busy`), worktree
  de host'tan okunamayan bir named volume'de. Bu yüzden mentor host'ta
  `LocalTransport` ile, araçsız ve 1-2 turla koşar. Dosyayı motor `exec/`
  üzerinden derler:
  - safhanın başlığı, gerekçesi ve kabul ölçütleri (rolün görevi);
  - sinyalin kanıtı: tekrar okunan dosyanın ilgili dilimi, tekrar eden
    komut ve sonucunun özeti;
  - agent'ın son birkaç metin mesajı;
  - `git diff --stat` ve gerekiyorsa kısa diff.
  Hepsi `scrubSecrets`ten geçer (Kural 4). Mentor dosya yazmaz; diff'in tek
  yazarı junior agent'tır.
- **Cevap emir değil, ÖNERİDİR.** Junior'a "Mentor önerisi" başlığıyla
  gider, sonunda da şu not durur: "doğrula, uymuyorsa gerekçesini yazıp kendi
  yolunla devam et". Mentor yalnız motorun derlediği dosyayı gördü; junior
  ise worktree'nin tamamını görüyor. Körü körüne uygulanan bir öneri yeni
  bir döngü başlatır. Önerinin doğruluğunu build, test ve insan kapıları
  sınar; mentorun yetkisi yoktur.
- **Teslim: koşan oturuma, turu kesmeden.** Sinyal yakalanınca motor köprüye
  `run.hold` gönderir. Köprünün `PreToolUse` kancası junior'un SIRADAKİ araç
  çağrısını mentor cevabı gelene kadar bekletir; gözcü bunu `pendingAsks`
  gibi bilinçli bekleme sayar. Cevap `run.guide` ile gider ve bekleyen o
  çağrıya `PreToolUse` kancasının `additionalContext` alanıyla düşer (SDK
  0.3.295'te doğrulandı). Paralel çağrılarda öneri yalnız birine verilir
  (`GuideGate`, `shared/guide.ts`). Böylece canlı kanalı olmayan tek atışlık roller de
  (QA, DevOps) cevabı alır. Oturum ve bağlam korunur.
  `LocalTransport` aynı kancayı kendi `query()`sine takar. Bekleme süresi
  sınırlıdır; dolarsa kanca serbest bırakır ve iş sürer.
- **Eski köprü:** imajı tazelenmemiş konteyner `run.hold` mesajını tanımaz.
  Köprü `bridge.hello`da `capabilities: ["guide"]` bildirir; bildirmiyorsa
  mentor koşmaz, `agent.mentor` olayı "atlandı" sebebiyle düşer (koşu başına
  bir kez). Sessizce askıda kalmak yok
  (`tester` rolünde yaşanan eski-köprü kilidinin dersi).
- **Sınırlar profilde (`agents.mentor`):**
  - `enabled` (varsayılan **kapalı**; triage ile aynı gerekçe, sürüm
    yükseltmede davranış sessizce değişmemeli);
  - `mode: "observe" | "consult"`;
  - `roles`;
  - eşikler (`repeatRead`, `repeatFailure`, `noProgressTools`);
  - `maxConsultsPerRun` (2), `maxConsultsPerJob`;
  - danışma başına `maxBudgetUsd` ve `maxTurns`;
  - `holdTimeoutMinutes`.
  Tavan dolunca yeni sinyal yalnız bildirilir. Aynı sinyal danışmadan sonra
  yeniden tetiklenirse bir sonraki danışma bir basamak daha yukarı gider (yine
  `maxTier`a kadar).
- **Önce gözlem.** `observe` modunda sinyaller yalnız akışa düşer
  (`agent.stuck` olayı) ve mentor koşmaz. Eşikler gerçek işlerde yanlış
  pozitife karşı ölçülmeden `consult` açılmaz.
- **Durum değişmez.** Danışma bir geçiş değildir (Kural 1). Döngü sayaçlarına
  dokunmaz, iş NeedsAttention'a düşmez; triage ve §21 gibi danışmandır.
- **İz:** `agent.mentor` WS olayı (kayıtlı, `job_events`). Olayda sinyal,
  junior modeli, mentor modeli, cevap ya da atlanma sebebi ve maliyet
  bulunur. `messages` satırı yazılmaz: mentor koşusu `nested`dır, akışa
  agent.start/end/message yazmaz (UI asıl koşu bitti sanmasın) ve işin iptal
  kolunu ezmez. Koşu `agent_runs`ta, maliyet `cost_records`ta
  `role: "mentor"` ile durur.
  Ekranda "Sonnet → Opus'a danıştı: aynı dosyayı 4 kez okudu" gibi görünür ve
  insan araya girebilir.
- **Kimlik:** mentor havuzdan kendi kimliğini alır (`options.env`, Kural 5).
  Kota mentoru düşürürse danışma atlanır ve junior serbest bırakılır.

**Bilinçli yapılmadı:**
- Mentorun worktree'yi kendisinin okuması. İkinci eşzamanlı köprü koşusu
  gerekir, bir de mentorun kendi döngüsüne girme riski doğar.
- Agent'ın kendiliğinden çağırdığı `ask_mentor` aracı. Önce motor tespiti
  ölçülsün; araç sonra eklenebilir, aynı danışma hattını kullanır.
- Danışma yerine modeli koşu ortasında yükseltmek. O §22/§25'in işi ve
  bütün oturumu pahalı modele taşır.

## 34. Adım kontrol listesi: geçen adım yeniden koşmaz

**Sorun (insan talebi, 2026-10-09):** PRReview'da kota dolup (Claude ya da
inceleme sağlayıcısı) iş düşünce "yeniden dene" PR öncesi zinciri BAŞTAN
koşuyordu: güvenlik, kod kalitesi ve yerel inceleme aynı kod üzerinde
yeniden. Sebep: temiz geçen adım iz bırakmıyordu. Tur sayaçları
(`static_review`, `local_review`) yalnız bulgu varken artıyor; model seçilerek
yapılan retry bazılarını sıfırlıyor. Güvenlik kapısındaki "kalanlarla devam"
kararı da yalnız bellekte duruyordu; retry kapıyı yeniden açıyordu.

**İlke (insan):** Genel kural, adım özelinde: geçen adım, kodu değişmedikçe
yeniden koşmaz.

**Karar:**
- `jobs.step_checklist` (migration 0020): `{ "<durum>.<adım>": { status,
  at, sha, note } }`. Bugünkü anahtarlar `pr.security`, `pr.quality`,
  `pr.local_review`, `pr.bot_review`, `qa.write`. Yeni bir adım aynı kusuru taşıyorsa
  anahtar eklenir.
- `done`: adım işini bitirdi. Temiz geçti, düzeltildi ya da tavan doldu;
  kalan bulgular botta ya da insanda. `waived`: insan kapıda kalanları kabul
  etti (güvenlik kapısı ya da inceleme turu kapısında "devam").
- Adım KOŞAMADIYSA (anahtar yok, araç düştü) kayıt yazılmaz; yeniden
  denemede yeniden denenir.
- Tamamlanmış adıma gelince akışa "daha önce tamamlandı; yeniden
  koşulmuyor" notu düşer.
- "Bir tur daha" (güvenlik kapısında onay) insanın açık isteğidir; kayda
  bakmaz.
- **Geçersizleşme — commit'e bağlı (insan talebi, 2026-10-10):** iş
  PRReview'dan önceki bir duruma (Planning … QA) girince kayıtlar aynı
  transaction'da (`move`) silinmez, `stale` işaretlenir. PR zinciri
  başında (`revalidateSteps`, `main` senkronundan ÖNCE) çalışma ağacı
  temizse ve HEAD en son tamamlanan adımın `sha`sına eşitse kayıtlar geri
  gelir; değilse silinir. Eskiden koşulsuz siliniyordu: LiveTest'e
  "yeniden aç" kodu değiştirmediği hâlde SAST'ı baştan koşturuyordu
  (yaşandı). NeedsAttention, PRReview ve CIWatch işaretlemez. Zincirin
  kendi düzeltme commit'leri önceki adımları geçersiz kılmaz: karşılaştırma
  en son adımın `sha`sıyla yapılır, o commit'ler orada zaten var.
- **DAST da aynı ilkeyle:** özet `sha` (temiz ağaçta HEAD) ve `configKey`
  (`live.dast` ayarının özeti) taşır. "Yeniden kaldır" ya da LiveTest'e
  yeniden açılış, ikisi de aynıysa ve önceki tarama rapor okuyabildiyse
  taramayı yinelemez, özeti yeni kapıya taşır. Taşınan özetle `autoFix`
  açılmaz: o kod için karar zaten verildi. Yalnız birincil repo HEAD'ine
  bakılır (PR zinciri de yalnız onu inceliyor).
  **Düzeltme (2026-10-12):** "temiz ağaçta HEAD" şartı DAST'ı Yeniden
  kaldır'da hiç taşıtmıyordu — canlı konteyner build zincirini worktree'de
  koşuyor ve ağacı kirletiyor. Kimlik artık `tree`: geçici index'e
  `add -A` + `write-tree` (ignore'a uyar, asıl index'e dokunmaz, temiz
  ağaçta `HEAD^{tree}`). Taşınmazsa sebep (değişen dosyalar, ayar farkı)
  akışa yazılır.
- **PR öncesi `main` senkronu (§32):** çakışma çözülerek birleştiyse güvenlik,
  kalite ve yerel inceleme kayıtları silinir. Çözüm agent'ın yazdığı yeni
  koddur ve önceki denetimler onu görmedi. Çakışmasız merge silmez, çünkü
  uzak `main` incelenmiş sayılıyor.
- **Bot incelemesi:** geçtiyse PRReview'a yeniden girişte (ör. "Yeniden aç →
  PRReview") bot yeniden beklenmez. Sonradan gelen yorumları CIWatch zaten
  DevOps'a veriyor.

**Denetlendi, döngü yok:**
- CIWatch kırmızıda PRReview'a dönmüyor. DevOps CIWatch içinde düzeltiyor,
  statik analiz ve yerel inceleme yeniden koşmuyor.
- PR açıldıktan sonraki retry CIWatch'a gider; sayaçlar (`ci`,
  `ci_merge`) kalıcı.

**QA (`qa.write`, insan talebi 2026-10-10):** QA yazıp takımlar yeşil
geçince kayıt düşer. `sha` HEAD değil, çalışma ağacının TAMAMININ git
tree'si (geçici index + `git add -A` + `write-tree`): QA'nın testleri PR
açılana kadar commit'lenmiyor, HEAD onları görmez. Ağaç QA agent'ı bitince,
takımlardan ÖNCE okunur (test çıktısı ağacı kirletmesin). Sistem QA'ya
girerken (LiveTest onayı, "Yeniden kaldır" sonrası, QA'dan retry) ağaç aynıysa
QA agent'ı ve takımlar koşmaz; son `pr_open` kapısının yükü (sonuçlar,
handoff) yeni kapıya taşınır. "Yeniden aç → QA" insanın açık isteğidir,
kayda bakmaz. `stale` işareti bu anahtar için anlamsız; ağaç hash'i kodun
kendisi. PR zincirinin HEAD doğrulaması (`revalidateSteps`) yalnız `pr.*`
anahtarlarına bakar.

## 35. Kod haritası: prompt'a girmez, ajan ihtiyacı kadar açar

**Sorun (insan gözlemi, 2026-10-12):** Planner her işte aynı dosyaları
okuyor. İşler arasında hafıza yok: her iş yeni SDK oturumu, hedef projenin
`CLAUDE.md`'si yüklenmiyor (`settingSources` yok), `docLayers` "her işte
önce buraya bak" diyor. Proje her işte sıfırdan keşfediliyor.

**Reddedilenler:**
- *Vektör RAG:* kodda benzerlik araması çağrı zincirini bulmaz; her
  commit'te embedding bayatlar; Anthropic'te embedding yok, ayrı servis ve
  depo gerekir.
- *Haritayı prompt'a gömmek:* önbellek fiyatı düşürse de bağlam penceresini
  doldurur, dikkati dağıtır; işe gerekmeyen modüllerin özeti her işte taşınır
  (insan kararı: "ihtiyacı kadar sorsun").

**Karar:**
- Harita **dosya** olarak durur: `INDEX.md` (modül başına tek satır) ve
  `modules/<id>.md` (künye: kilit dosyalar, giriş noktaları, sözleşmeler,
  entity'ler, uçlar, bağımlılıklar, tuzaklar). Gerçek kaynak `map.json`
  (`CodeMapSchema`); markdown ondan sunucuda üretilir.
- `<artifactsDir>/codemap/<projectId>/` altında — hedef workspace'e
  yazılmaz (Dockerfile ile aynı ilke). Konteynere `/codemap` olarak SALT
  OKUNUR bağlanır. Prompt'a yalnız tek satır girer, o da `INDEX.md` varsa.
- Üretimi ayrı rol yapar (`cartographer`, salt okunur, host'ta kaynak
  checkout üzerinde). Analyst'in profil koşusu şişmesin diye ayrı.
- **Tazelik commit'e bağlı:** her künye üretildiği commit'i taşır. Kaynak
  senkronundan sonra `git diff --name-only <sha>..HEAD`: modülün dizinine
  düşen değişiklik künyeyi `stale` yapar; künye silinmez, "şu dosyalar
  değişti, kodu doğrula" notuyla kalır. Değişmeyen modülün `sha`sı ilerler.
  Hiçbir modüle düşmeyen değişiklik `unmapped` olarak INDEX'te görünür.
  Bayat künyeler arka planda yeniden üretilir; iş beklemez.
- Profil alanı `agents.codeMap` (`enabled` varsayılan kapalı, model,
  bütçe). Motor yeteneği sunar, profil açar.
- Kazanç `GET /api/projects/:id/agent-reads` ile ölçülür: yönlenme
  okumaları (ilk 15 çağrı) ve iş başına token, harita öncesi/sonrası.
## 36. Ahtapot'un kendi sürümü: elle tetiklenen yayın, conventional commit

**Sorun (insan, 2026-10-12):** yayın `v*` tag'inin push'una bağlıydı. Sürüm
numarasını insan hesaplıyor, tag'i elle atıyor, imajın çıkmasını bekliyordu.
Numara elle seçildiği için atlama ve tekrar riski vardı; tag atmak tek başına
yayın demekti.

**Karar:** Northwind'in `ci.yml`'indeki akış.
- `.github/workflows/release.yml`, yalnız `workflow_dispatch` (yalnız `main`).
  Girdiler `bump` (`auto`/`patch`/`minor`/`major`), `dry_run`, `ahtapot_id`.
- `auto`: son kararlı `vX.Y.Z` tag'inden beri commit'lerden; kural
  `release/semver.ts` → `inferBump` ile aynı (`!`/`BREAKING CHANGE` major,
  `feat` minor, kalan patch). Commit yoksa koşu kırmızı; boş sürüm çıkmaz.
- Sıra: imaj (`docker-server.yml`, `workflow_call`) → tag + Release (`gh
  release create --generate-notes`). Build düşerse tag açılmaz.
- `docker-server.yml` artık tag'i dinlemiyor; elle tetikleme yalnız build
  doğrular.
- Girdi adları §27'deki profil varsayılanlarıyla uyumlu: Ahtapot kendi
  sürümünü Release kartından da çıkarabilir (`correlationInput: ahtapot_id`).

**Elenen:** `ietf-tools/semver-action` (Northwind'deki). Kural `inferBump` ile
ayrışırdı; zamanlı yayın ile elle yayın farklı sürüm hesaplardı. Üçüncü taraf
action yerine kısa bir bash (bkz. `clean.yml` gerekçesi).

## 37. Servisler tek katalogda; canlı ortam ve testler adla bağlanır

**Sorun (Northwind, 2026-10-13):** aynı Postgres iki yerde tanımlıydı —
`live.dependencies` (gerçek adres `192.168.1.30`, `cloneDb` ile şablondan klon)
ve test takımının kendi `services` listesi (boş). Entegrasyon komutu compose
adına (`Host=postgres`, `redis:6379`) bağlanıyordu; düzeltme doğrulamasında bu
ad çözülmüyor, ön kurulum düşüyor, baseline da aynı nedenle düştüğü için
"önceden kırık" sayılıp takım **yeşil** geçiyordu. Entegrasyon hiç koşmuyordu.
Sıfır kurulum (CI'daki gibi boş Postgres) da çözüm değildi: tohum verisi
gerekiyor, klonu bu yüzden alıyoruz.

**Karar:**
- Üst düzey `services[]`: servis BİR KEZ tanımlanır (konteyner ya da
  `externalHost` ile sabit servis).
- `database.clone`: şablon ve klon kuralları (eski `live.cloneDb` nesnesi,
  `enabled` hariç). Şablonun migrate/seed'i zaten `database` altındaydı.
- Tüketiciler adla başvurur: `live.services` + `live.cloneDb` (bool),
  `test.suites[].services` + `test.suites[].cloneDb` (bool).
- Test takımı `cloneDb` ile **her koşuda** (baseline ve gerçek koşu ayrı)
  şablondan taze bir klon alır; bağlantı dizesi (§38: `appEnv` + `$dbCloneConnectionString`) ile
  motor tarafından verilir, koşu bitince klon düşer. Ad
  `<şablon>_t_<kısa kimlik>_<b|r>_<takım>` — canlı klonun adı (54 karakter)
  son ek almaya yetmiyordu, Postgres 63 baytta sessizce kırpar.
- Servis adresleri komuta `AHTAPOT_SVC_<AD>_HOST/_PORT` olarak verilir.
- Ortam kurulamazsa (tanımsız ad, konteyner servisi, şablon yok, klon
  açılamadı) takım **kırmızı** ve `setupError` taşır: baseline onu silmez,
  düzeltme doğrulaması agent'a geri göndermez (düzeltecek kod yok), QA işi
  `qa_env` ile insana bırakır.
- Eski profiller okurken çevrilir (`upgradeLegacyProfile`, kök şemada
  `z.preprocess`); onaylı sürümler bozulmaz, editör yeni biçimle açar.

**Sınır:** test klonu yalnız DIŞ Postgres'te. Konteyner servisi testte §38'le
geldi ama BOŞ kalkar; klon şablonu onda yaşamaz. Test klonu şablonu KURMAZ —
kurulum uygulamanın tamamını (Redis, ES) istiyor ve yalnız canlı ortamın
compose ağında mümkün (bkz. `04-template-db.md`). Şablon yoksa takım açık bir
hatayla kırmızı olur.

**Elenen:** test başına sıfır kurulum (CI gibi). Tohum verisi gerekmekte ve
`--install=true` her koşuda dakikalar sürüyor; klon ~9 sn.

## 38. Uygulama env'i tek tabloda; klon dizesi yer tutucuyla

**Sorun (2026-10-14):** aynı uygulama iki ayrı env diliyle koşuyordu. Canlı
ortam `live.app.env`i okuyor ve yer tutucuları (`$jobIdShort`) çözüyordu;
entegrasyon takımı kendi `command.env`ini okuyor ve yer tutucuları ÇÖZMÜYORDU
(`$jobIdShort` metin olarak gidiyordu). Klon dizesini motor iki tarafta da
sabit bir ada (`connectionStringEnv`, boşsa Northwind'in
`DataSettings__DataConnectionString`i) kendiliğinden yazıyordu; test projesi
dizeyi başka bir addan (`ConnectionStrings__Test`) okuyorsa profilde bunu
ifade etmenin yolu yoktu.

**Karar:**
- Üst düzey `appEnv`: canlı ortam ve servis/klon isteyen takımlar
  (`suiteUsesAppEnv`) AYNI tablodan beslenir. Bağımlılıksız birim takımı almaz.
- Motor hiçbir sabit ada yazmaz. Klon dizesi `$dbCloneConnectionString`
  yer tutucusuyla, profilin seçtiği değişkenlere gider. `connectionStringEnv`
  ve Northwind varsayılanı kalktı.
- Değerler bağlama göre değişir, adlar değişmez: canlıda iş klonu, testte
  koşunun klonu (baseline ve gerçek koşu ayrı).
- `$runId`: canlıda `$jobIdShort`, testte `<jobIdShort>_<b|r>_<takım>`.
  `$jobIdShort` ile kurulan Redis/Elastic öneki canlı ortam ile aynı işin
  testini aynı anahtarlarda buluştururdu.
- Takımın `command.env`i kalır, yalnız teste özgü farklar için; `appEnv`i
  ezen giriş doğrulayıcıda uyarı. Öncelik: `AHTAPOT_SVC_*` < `appEnv` <
  komut env'i.
- Çözülemeyen yer tutucu (klon yokken `$dbCloneConnectionString`) ortamı
  KURDURMAZ: takım `setupError` ile kırmızı, canlı ortam hata. Eskiden canlı
  klon kurulamazsa "profildeki bağlantı kullanılacak" uyarısıyla devam
  ediliyordu; yer tutucuyla bu, uygulamaya `$…` metnini bağlantı dizesi diye
  vermek olurdu.
- Şablon kurulumu (`migrate` + `seed`) klon dizesini taşıyan her değişkeni
  şablonun dizesiyle ezer.
- Eski profiller okurken çevrilir (`upgradeAppEnv`): `live.app.env` →
  `appEnv`; klonu kullanan tüketici varsa eski ad `$dbCloneConnectionString`
  alır.

**Ek (aynı gün, Northwind'de uçtan uca denendi):**
- `live.emptyEnv` de uygulama yapılandırmasının parçası; `appEnv`i alan
  takıma da tek boşluk olarak gider. Gitmediğinde Northwind'in kurulum ön adımı
  Serilog'un Elasticsearch sink'iyle `localhost:9209`a bağlanıp 134 ile çıktı.
- Testte KONTEYNER servisi: koşu başına bir ağ (`ahtapot-t-<runId>`), servisler
  canlıdakiyle AYNI adla (ağ takma adı) ve BOŞ kalkar, `healthCmd` geçene kadar
  beklenir, agent konteyneri ağa bağlanır, koşu bitince hepsi yıkılır. Böylece
  `appEnv`deki `Host=postgres` / `redis:6379` iki bağlamda da aynı değer.
  Baseline ve gerçek koşu ayrı servis alır. Ölçüm: Northwind integration 170
  testi ~2 dk'da koştu; servislerin kalkışı birkaç saniye.

**Sınır:** tek tablo, canlıda sabit bir DB ile testte klonu aynı anda
istemeyi yasaklar (`live.cloneDb` kapalı + takımda klon). Bu bilinçli: iki
taraf aynı yapılandırmayla koşmalı. İşe özel değişkenler (`jobs.live_env`)
yalnız canlıya gider; insan onları canlı ortamda elle denemek için yazıyor.

## 39. Öğrenme: merge sonrası dersler haritacının tazelemesine biner

**Sorun:** haritacı `pitfalls`a yalnız statik okumada görüneni yazar. İş
içinde çarpılan tuzak (sessiz bozulan derleme, yanlış varsayılan sözleşme)
handoff `gotchas`ında kalıyor, yalnız aynı işin sonraki safhasına gidiyor ve
iş kapanınca kayboluyordu. Taslak `05-orc-takeaways.md` "Sonraya" bölümünde.

**Karar (2026-10-15, kullanıcıyla):**
- **Tetik merge.** Merge edilmemiş işin tuzağı kanıtlanmış değildir.
  `mergeAndCleanup` → kaynak senkronu → `refresh(…, lessons)`.
- **Ayrı LLM adımı yok, ayrı depo yok.** Merge zaten kaynağı ilerletiyor ve
  haritacıyı bayat künyeler için koşturuyor. Dersler o koşuya biner: işin
  dokunduğu künyeler (handoff `filesTouched` ∩ modül `paths`) bayat olmasa da
  yeniden üretime girer, haritacı dersi kodla doğrulayıp `pitfalls`a işler.
  Taslaktaki `learned.json` + render'da birleştirme gerekmedi.
- **Ayıklamayı LLM yapar.** Hammadde: handoff `gotchas`/`blockers`/
  `deviations` (sentezlenmiş handoff hariç), kırmızı build'ler (adım + log
  kuyruğu), insanın safha/canlı test ret yorumları. İşe özgü ile
  genellenebiliri ayırmak haritacının işi.
- **İnsan onayı yok — merge yeter.** Yanlış not kalırsa sonraki tazelemede
  kodla düzelir. Ret kaydı tutulmaz.
- **Harita kapalıysa not tutulmaz.** Hiçbir künyeye düşmeyen ders de atılır.
- Profil `agents.codeMap.learn`, varsayılan kapalı.

**Sınırlar:** koşu sürerken gelen dersler bellekte bekler, koşu bitince
tazeleme yeniden tetiklenir; sunucu yeniden başlarsa düşer. Tam üretim
(`generate`) mevcut haritayı görmez, öğrenilmiş tuzaklar orada kaybolur;
kısmi tazelemede haritacıya "mevcut tuzağı koru" denir. `pitfalls` tavanı
10; aşan liste sentezde kırpılır (modül düşmez). Yalnız Ahtapot'un kendi
merge kapısından geçen iş ders verir; dışarıda merge edilen PR vermez.

## 40. Otopilot işe özel ve yalnız geliştirme adımında

`jobs.autopilot` açıkken Developing/Building'de insan beklenmez: safha kapısı
açılır ve `decidedBy: "autopilot"` ile hemen onaylanır (commit ve denetim izi
insan onayındakiyle aynı), `ask_user` anında "kendin karar ver" cevabı alır,
bloksuz biten tur beklemeden dürtülür. Developer prompt'una her varyantta bir
`<autopilot>` notu eklenir — devralınan oturum sistem prompt'unu yeniden
görmediği için.

**Neden profil alanı değil:** safha onayı profilin disiplini, ama "bu işi
başından ayrılarak bitir" kararı tek bir işe ait — insan bazı işlerde
safha safha bakmak, bazılarında bırakmak istiyor. Profil varsayılanı değişmez.

**Neden yalnız geliştirme:** plan onayı neyin yapılacağına, canlı test / QA /
PR kapıları sonucun kabulüne dair; bunlar insanın kalmalı. Bayrak her
kullanımda (soru, kapı) o an okunur: koşu sürerken açılıp kapanabilir; açılınca
bekleyen soru, bloksuz bekleyiş ve açık safha kapısı hemen çözülür.

## 41. LiveTest'te tarayıcı testi: ayrı adım değil, checklist'in ön işareti

Profilde `live.browserTest` (varsayılan kapalı) açıkken LiveTest, kapıdan
önce, DAST'tan sonra: `tester` senaryoları otomatik çıkarır, aynı oturumda
Playwright MCP ile **tek koşuda** yürütür, checklist'i `source: "agent"` ile
işaretler. Ayrıntı: [`06-live-browser-test.md`](06-live-browser-test.md).

**Neden yeni durum (UAT) değil:** insanın kabul testi zaten LiveTest'in işi
ve checklist orada; ikinci bir kapı aynı listeyi iki kez onaylatırdı. Agent
turu DAST/statik analiz gibi bir ön filtredir, kapının yerini almaz.

**Neden Playwright MCP, browser-use değil:** Claude tarayıcıyı kendisi sürer;
ikinci LLM, ikinci anahtar ve Python yığını gerekmez. browser-use'un QA
yöntemi cloud tarayıcı + localhost tüneli şart koşuyor — Northwind'in canlı
ortamı (`.run/` canlı JWT) dışarı açılamaz.

**Neden agent "kaldı"sı Developer'a kendiliğinden gitmez:** LLM'in kararı
belirlenimci değil; yanlış "kaldı" bir düzeltme safhası ve build turu yakar.
İnsan kapıda kalanları görür, reddederse mevcut `carryScenarioMarks` taşır.
`autoFix` profil bayrağıyla ileride açılabilir.

**Giriş bilgisi profilde:** değerler prompt'a girmez (agent yalnız adları
görür), `scrubSecrets` desen tabanlı olduğundan değerler ayrıca kayıtlı değer
olarak maskelenir (kural 4).

**Neden hesaplar rol + açıklama taşır:** aynı uygulamada yetkisi farklı
kullanıcılar olur; düz ad → değer tablosunda agent hangi kullanıcıyla
gireceğini bilmiyordu ve yetki senaryosu yanlış hesapla "geçebilirdi".
Senaryo `account` alanında rolü taşır; seçim üretimde (planı gören tester)
yapılır, tarayıcı turunda değil — insan da aynı senaryoyu elle koşarken
hangi hesabı kullanacağını görür.

**Neden sonucu eksik senaryo işaretsiz kalır, "kararsız" sentezlenmez:**
agent'ın denemediği senaryoya iz bırakmak insanı yanıltır; işaretsiz satır
"buna sen bak" demektir. Kural 3'ün sentezi burada özetteki `noResult` sayısı.

**Tarayıcı insanın adresine gider (2026-10-17 düzeltmesi):** canlı test
adımında insana verilen adres (`appUrl`, ör. `192.168.1.50:20001`) agent'ın
da hedefidir; izinli kökenler aynı host'taki yayınlanan portlardır (UI +
API). İç IP'ye gitmek insanla agent'ın farklı adres test ettiği izlenimini
veriyordu ve `browserTest.baseUrl` gibi gereksiz bir ayar doğuruyordu.
Edge ağı yalnız adres loopback'teyken yedektir.

**Neden (yedekte) iş konteyneri edge ağına bağlanır:** yayınlanan portlar host
loopback'inde; konteynerin içinden `127.0.0.1` kendisidir. Bağımlılıkların
`internal` ağı agent'a açılmaz — tarayıcının veritabanına doğrudan erişmesi
için sebep yok.

## 42. İkinci göz: Claude düzenler, ikinci model eleştirir

**Sorun (insan talebi, 2026-10-17):** iş tanımı dağınık giriliyor; Planner
ve tester ham metinden besleniyor, insan metnin nasıl anlaşıldığını plan
onayında ayrıca görmüyor.

**Karar:** iki parça. (1) Planner ham metinden numaralı **gereksinim
listesi** çıkarır (alıntıyla), safhalar ve senaryolar karşıladıklarını
işaretler; ham metin değişmez. (2) Profilde `workflow.review.critic.plan` /
`.scenarios` açıksa (varsayılan kapalı), yerel incelemede
tanımlı sağlayıcının modeli ham metin + gereksinimler + plan/senaryoları
karşılaştırır, bulguyu insana danışman notu olarak gösterir. Ayrıntı:
[`07-plan-critic.md`](07-plan-critic.md).

**Neden düzenleyen Claude, ikinci model değil:** bağlam (repo, kod haritası,
profil, emsal) Planner'da. Bağlamsız modele yeniden yazdırmak niyeti düzgün
ama yanlış cümlelerle doldururdu; eleştirmen yanılırsa en kötü ihtimalle
gereksiz bir not kalır.

**Neden ikinci model (kullanıcı):** üç göz — farklı model, Claude'un kendi
yorumundaki kör noktayı yakalar. Metin karşılaştırması repo bağlamı istemez.

**Neden `review.local`ın sağlayıcısı:** anahtar, uç nokta, protokol orada
tanımlı ve ölçülü (§20). OCR kapalıyken de kullanılabilir; model ayrıca
seçilebilir.

**Neden kapıyı bekletmez, Planner'a kendiliğinden gitmez:** §20 ve §41 ile
aynı — danışman bir ön filtre; LLM kararı belirlenimci değil, yanlış bulgu
plan turu yakar. İnsan seçtiği bulguyu ret yorumuna ekler.

**Neden sentez yok:** `CRITIQUE_JSON` yoksa "bulgu yok" uydurmak insanı
yanıltır; satır `failed` kalır (kural 3'ün sentezi burada durumun kendisi).

**Yedek (2026-10-17, yaşandı):** OpenAI kredisi bitti (429
`insufficient_quota`), senaryo eleştirisi hiç koşmadı. Dış sağlayıcı düşerse
(HTTP hatası, zaman aşımı, anahtar/model eksik) eleştiri Claude havuzunda
araçsız yan koşu olarak (mentor kalıbı, §33) tekrarlanır —
`critic.fallback`, varsayılan açık, model `claude-opus-5-5`. Farklı modelin
kör nokta avantajı kaybolur ama ikinci okuma kalır; satırın `model` alanı
yedeğe çevrilir, akış notu ilk sebebi söyler. Ayrıştırma hatası yedeği
tetiklemez: sağlayıcı cevap verdi, sorun cevabın kendisinde.

## 43. Büyük plan alt işlere bölünür, alt işler LiveTest'te birleşir — TASLAK

**Durum:** taslak, onaylı ana plandan sapma (iş → alt iş yeni kavram).
Uygulanmadı.

**Sorun (insan talebi, 2026-10-17):** Planner 48 ve 78 adımlık planlar
üretti (§25). Tek iş içinde bu kadar safha; tek canlı test turunda hepsini
doğrulamak zor, ortada çıkan kusurun geri dönüşü pahalı, her safha sırayla
insan onayı ve build bekliyor. İlk fikir "eşiğin üstünde Developer takım
lideri gibi davranıp safhaları paralel senior'lara dağıtsın" idi; tek iş
içinde paralel Developer reddedildi (aşağıda).

**Karar:**
- **Eşik profilde:** `workflow.split: { enabled, maxPhases, maxFiles }`.
  Ölçü adım değil safha ve dosya sayısı — Planner'ın adım ayrıntısı işten
  işe değişiyor, safha zaten "birlikte incelenebilir" birimdir. İkisinden
  **herhangi biri** aşılınca eşik aşılmış sayılır: az safhaya sıkıştırılmış
  çok dosyalı bir plan da tek canlı testte doğrulanması zor bir iştir.
  Kapalıyken bugünkü davranış aynen sürer.
- **Lider Planner'dır:** eşik aşılınca ana işin planı safha yerine
  `subtasks[]` taşır — her biri `{ id, title, scope, acceptance, dependsOn[] }`.
  Bölme önerisi plan kapısında insana gelir; insan "bölme" diyebilir.
- **Alt iş normal bir iştir:** kendi `jobs` satırı (`parent_id`), kendi
  worktree'si ve dalı, kendi Planning → PlanReview → Developing → Building
  akışı, kendi safha kapıları ve model seçimi (§25). Fark tek: **LiveTest'e
  girmez**, yeşil build'de `Done` olur. Canlı ortam, QA, PR alt işte yok.
- **Ana iş bekler:** PlanReview'dan sonra yeni `Coordinating` durumuna girer
  (geçiş yine `transition.ts`'ten). Bağımlılığı bitmiş alt işler başlatılır;
  paralellik mevcut kaynak semaforlarıyla sınırlı — alt iş canlı ortam
  almadığı için ucuzdur (worktree + build).
- **Birleşme artımlı, doğrulama tek:** biten alt işin dalı hemen ana işin
  dalına merge edilir. Bağımlı alt iş ana dalın o anki hâlinden açılır —
  bağımlı olduğu kod orada hazırdır. Çakışma çıkarsa ana işte bir
  "birleştirme safhası" açılır, Developer çözer, insan onaylar. Tüm alt
  işler bitince ana iş Building → **LiveTest** → QACases → QA → PRReview →
  CIWatch: tek canlı test, tek PR.
- **LiveTest/QA'da kusur ana işte düzeltilir:** düzeltme safhası ana işin
  worktree'sinde açılır; kapanmış alt iş yeniden açılmaz.
- **Alt iş takılırsa:** `NeedsAttention` alt işte kalır, ana iş
  `Coordinating`de bekler, bağımlıları başlamaz. Alt iş iptal edilirse ana iş
  `NeedsAttention`a düşer — eksik parçayla birleşmek insan kararıdır
  (yeniden planla ya da devam et).
- **Kural 3:** Planner eşik aşılmışken `subtasks` yazmazsa motor kendi
  bölmez (bölmek anlam ister); plan kapısında "eşik aşıldı" uyarısı çıkar,
  insan bölerek yeniden planlatabilir. `dependsOn` döngüsü ya da bilinmeyen id
  Zod/doğrulamada reddedilir.

**Neden tek iş içinde paralel Developer değil:** aynı worktree'de iki
Developer birbirinin dosyasını ezer; ayrı worktree'de sonunda yine birleştirme
gerekir ama iş akışında yeri yoktur. Safhalar çoğunlukla bağımlıdır (şema →
API → UI) ve plan bağımlılık taşımıyor. Paralel üretilen safhalar insan
onayında ve build'de yine sıraya girer — darboğaz yer değiştirir, kalkmaz.
Alt iş ise mevcut her şeyi (kaynak tahsisi, kapılar, model seçimi, worktree)
olduğu gibi kullanır.

**Neden alt işte LiveTest yok:** Northwind'de tam build ~27 dk ve canlı ortam
pahalı; parça parça canlı test hem kaynağı hem insan zamanını N katına
çıkarır, üstelik parçalar ayrı ayrı çalışır görünüp birlikte bozulabilir.
Kabul testi bütünün üzerinde yapılır.

**İnsan kararları (2026-10-17):**
- **Alt işte tam build yok.** Alt iş yalnız safha derlemesini (profilin
  koşullu derlemesi) koşar ve son safhası onaylanınca `Done` olur. Tam build
  alt işin dalı ana dala **merge edildiğinde** ana işte koşar. Kırmızıysa ana
  işte düzeltme safhası açılır; bağımlı alt işler build yeşile dönene dek
  başlamaz — kırık bir tabandan açılmasınlar. Bedeli: tam build alt iş sayısı
  kadar koşar, ama kusurlu parça birleştiği anda yakalanır.
- **Alt işin plan kapısı insana gelir, otopilot açıksa gelmez.** Ana planın
  onayı alt işlerin kapsamını zaten onaylamıştır; otopilotlu ana işte alt
  işin safha planı `decidedBy: "autopilot"` ile onaylanır (kapı açılır,
  kaydı kalır — §40'taki safha kapısıyla aynı). Bu, §40'ın "otopilot yalnız
  geliştirme" sınırının bilinçli genişlemesidir ve **yalnız alt iş plan
  kapısı** içindir: ana işin plan kapısı, LiveTest, QA ve PR kapıları
  insanda kalır. Otopilot alt işe ana işten miras geçer.
- **Otopilotun çözdüğü kapı bildirim üretmez.** Otopilotlu safha kapısı
  da `approval.required` yayınlıyor ve notifier bunu insana push ediyordu —
  kimse beklemediği hâlde (düzeltildi). Notifier böyle bir kapıda bildirimi
  hemen göndermez, 30 sn bekler: kapı o sürede çözülürse bildirim gitmez,
  hâlâ `pending`se otopilot onu çözememiştir ve insan duyar. Sunucu bu
  sürede yeniden başlarsa açılışta otopilotlu işlerin açık safha kapıları
  aynı süreyle yeniden planlanır. Otopilotta agent sorusu da bildirim
  üretmez — motor onu insana sormadan cevaplıyor. Alt iş plan kapısı
  uygulandığında aynı yoldan geçer.

**Açık:**
1. Merge sırası bağımlılık sırası (topolojik); bağımsız alt işler bitiş
   sırasıyla birleşir — iki bağımsız alt iş aynı anda biterse tam build'ler
   sıraya girer.

## 44. Kod grafiği: Trail, haritanın yanına MCP aracı olarak — DENEY

**Sorun (kullanıcıyla, 2026-10-21/22):** kod haritası (§35) modülün *ne iş
yaptığını* söylüyor ama *kimin neyi çağırdığını* bilmiyor. `contracts` ve
`dependsOn` LLM tahmini; "bu DTO'yu değiştirirsem kim kırılır" sorusunun
kesin cevabı yok. Tazeliği de LLM koşusuna bağlı. Trail-Code
(`@trailhq/trail-code`, MIT) tree-sitter ile sembol + çağrı grafiği kuruyor,
LLM'siz ve ücretsiz; her sorguda çalışma ağacına bakıp değişeni tazeliyor.

**Değerlendirme:** yerine geçmez, tamamlar. Grafik HTTP sınırını (.NET
endpoint ↔ React `fetch`) göremez; künyenin `endpoints`/`contracts`ı tam bu
boşluk. C# Trail'de "broad" seviyede: çağrılar adla eşlenir, kapsam/tip
çözümü yok, LSP katmanında C# sunucusu yok. TS/React tam destekli.
Yayımlanan kazanımlar (%46 daha az araç çağrısı, SWE-bench +12 puan) kendi
ölçümleri ve ağırlıkla Python; Northwind için kanıt değil — bu yüzden deney.

**Karar:**
- Profil `agents.codeGraph` (`enabled` varsayılan kapalı, `roles`,
  `buildTimeoutMinutes`). Motor yetenek sunar, profil açar.
- **`trail init` KULLANILMAZ.** Hedef repoya `.trail/`, `.claude/` hook'ları,
  `.mcp.json` ve `.gitignore` yazar; §35'in "hedef workspace'e yazılmaz"
  ilkesine ters. Hook'lar zaten yüklenmez (`settingSources` yok). Yalnız
  `trail build` + `trail mcp` kullanılır, ikisi de `--dir` ile.
- **Grafik worktree'nin DIŞINDA:** `CODEGRAPH_ROOT/<jobId>/<repo>`,
  konteynerin kendi diskinde. Ölçüldü (0.23.1): `--dir` dışarıdayken repo
  temiz kalıyor, commit edilmemiş değişiklik sorguda görülüyor.
- **Kurulumu motor yapar** (`executor`, koşudan önce, rol başına); köprü
  yalnız MCP'yi başlatır. `engine/` Docker'ı bilmez kuralı korunur.
  Artımlı: 183 dosyada soğuk 8 sn, tekrar 0,9 sn. Kurulamazsa koşu
  grafiksiz başlar ve insan bildirim görür — deney işi durdurmamalı.
- **Pull, push değil:** prompt'a araçların adı ve kısa kullanım notu girer;
  grafik içeriği girmez (§35 ile aynı ilke: "ihtiyacı kadar sorsun").
  Trail'in kendi ölçümünde de en doğru sonuç bu kipteydi.
- Repo başına bir MCP sunucusu (`trail`; çok repoda `trail-<repo>`).
  Salt okunur rollerin (Planner, QA case listesi) `allowedTools`una
  `mcp__trail*` eklenir; `bypassPermissions` rollerinde zaten açık.
- **Sır ve telemetri:** imajda `--ignore-scripts` (postinstall yalnız
  anonim "kuruldu" olayı yolluyor); çalışırken `DO_NOT_TRACK=1`. MCP
  sürecine kimlik anahtarları boş değerle ezilerek verilir (kural 5).
  `--deep` (kodu LLM sağlayıcısına yollar) kullanılmaz.
- Trail'in araç çıktısı ajana "kazandırdığım token'ı kullanıcıya söyle"
  diyor; kapatan ayar yok. Prompt notu bunu raporlamamasını söyler —
  yapılandırılmış blokların sonuna emoji satırı düşmesin.
- **Ölçüm:** `agent-reads` artık `mcp__trail*` çağrılarını sayıyor
  (`totals.graphCalls`, iş başına `graphCalls`, `searches` içinde kısa
  adla). Aynı türden işlerde grafikli/grafiksiz: yönlenme okumaları, iş
  başına token, plan/handoff kalitesi. Kazanç görünmezse özellik kaldırılır.

**Sınırlar:** nested repo (`Northwind.Forms`) varsayılan olarak grafiğe
girmez. `--follow-nested-repos` seçimi repoya `.graft/config.json` yazıp
`.gitignore`a satır ekliyor; bu yüzden açılmadı. Northwind.Forms ayrı bir
workspace reposu olarak tanımlıysa kendi sunucusunu alır. Trail'in
"learnings" kısmı (`.trail/learnings`, `trail check`) kullanılmıyor; §39 ile
örtüşüyor, ayrı karar ister.

## Açık sorular (deneyle netleşecek)

1. ~~**Windows Docker I/O**~~ — ölçüldü, bkz. §11.
2. Developer safhalar arası tek oturum mu, safha başına yeni oturum mu?
3. QA'nın Developer transcript'ini görmemesi doğru mu? (bias ↔ gereksiz soru)
4. Build'i agent mı orkestratör mü koşmalı? — melez muhtemelen doğru: orkestratör
   koşar, çıktıyı agent'a araç sonucu olarak verir.
5. Canlı test sırasında Developer canlı mı kalmalı? (idle maliyet ↔ akıcılık)
6. `run.ps1` PowerShell ve Windows yollarına bağlı; konteynerde `pwsh` mi,
   komutları ayrıştırmak mı?
