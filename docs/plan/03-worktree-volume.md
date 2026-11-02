# Worktree'yi named volume'e taşıma

Durum: **uygulandı ve ÖLÇÜLDÜ — build 30 dk → ~3 dk**
Tarih: 2026-09-17
İlgili: [`01-decisions.md`](01-decisions.md) §11 (R1), [`02-status.md`](02-status.md) "Worktree'yi named volume'e taşı"

## Neden

Worktree bugün `AHTAPOT_DATA\worktrees\<jobId>` altında, yani **Windows
NTFS'te** yaşıyor ve konteynere bind mount ediliyor
(`exec/docker.ts:149`). Her dosya okuması şu zinciri geçiyor:

```
NTFS  →  Docker Desktop  →  WSL2 (9p/virtiofs)  →  konteyner /workspace
```

Vite/Rolldown gibi on binlerce küçük dosyaya `stat`+`read` yapan araçlarda bu
katman ölümcül. Ölçülen: Northwind web build'i **30 dakikaya** çıktı; profil
çıktısı `northwind-shared-runtime load` 22 çağrıda 90.8 s, `vite:css transform`
tek çağrıda 91.4 s gösteriyor — plugin yavaş değil, **okuduğu dosyalar** 9p
üzerinden geliyor (log'un kendisi "callbacks overlap" diyor, süreler iç içe).

R1 ölçümü aynı yöne işaret ediyordu: named volume tam build'de 2×, artımlıda
**5×** hızlı (272 → 135 s, 90 → 19 s). O ölçüm .NET içindi; Node'da dosya
sayısı kat kat yüksek olduğu için ceza da daha büyük.

**Çözüm dosyaları Windows diskinden tamamen çıkarmak.** Konteynerde build
etmek değil sorun — dosyaların nerede durduğu sorun.

### Neden host'ta build etmek çözüm değil

Öneri geldi: build'i Windows'ta koş, Docker yalnız `run` yapsın. İki sebeple
hayır:

1. **Hız gelmez.** NTFS'in dosya başına açma/kapama maliyeti ext4'ün kat
   üstü, üstüne Defender her dosyayı tarıyor. R1 karşılaştırması "host mu
   konteyner mi" değildi — ikisi de konteynerdeydi, fark yalnızca dosyaların
   yeriydi.
2. **Sertleştirme düşer.** Agent `bypassPermissions` ile koşuyor; yasak
   bayrak kapısı, `docker.sock`un mount edilmemesi, pids/mem/cpu tavanı
   konteynere bağlı. Build host'a alınırsa agent'ın ürettiği komutlar
   doğrudan Windows'ta koşar.

## Kararlar (insan onaylı, 2026-09-17)

| Soru | Karar | Sonuç |
|---|---|---|
| Mirror nerede? | **Named volume'de** | Mirror + worktree tek FS; `git worktree add` konteynerde koşar |
| Git nasıl koşar? | **İş konteynerinde `docker exec`** | Mevcut `ContainerExecutor` yeniden kullanılır; yeni imaj yok |
| Windows'tan görünürlük | **Yok** | Diff/log UI'dan gelir; post-mortem `docker run` ile |

Sunucuya taşıma **kapsam dışı**: dış sunucuda prod var, riske atılmıyor.

## Mimari değişiklik

### Bugün

```
prepare() host'ta          →  Planner host'ta (cwd: worktreePath)
  git clone --mirror           ↓
  git worktree add          konteyner açılır (runtime.acquire)
  cpSync ignoredButNeeded      ↓
  rmSync sensitiveFiles     Developer + build konteynerde
                               ↓
                            commit/diff/push HOST git'inde
```

### Hedef

```
konteyner açılır (worktree volume mount, boş)
  ↓
prepare() KONTEYNERDE (docker exec)
  git clone --mirror → /vol/mirrors
  git worktree add   → /vol/worktrees/<jobId>
  kopyalama/silme    → konteyner içi
  ↓
Planner + Developer + build + commit/diff/push  hepsi konteynerde
```

**Kaynak workspace** konteynere **salt okunur** bind
mount edilir — mirror'ın fetch kaynağı ve `ignoredButNeeded` kopyalamasının
kaynağı odur. Salt okunur olması kritik: kullanıcının checkout'una
dokunulmayacağı kuralı böylece FS düzeyinde garanti altına alınır.

## Sıra bağımlılığı — planın omurgası

Bugün `prepare()` konteynerden **önce** koşuyor (`engine/job.ts:290`), ve
Planner `runtime.acquire()` kullanmadan doğrudan host worktree yolunda
koşuyor (`job.ts:352`). Volume'e geçince bu ters çevrilmeli: **konteyner
önce açılmalı**, çünkü worktree ancak onun içinden yaratılabilir.

Bu, Planner'ı da konteynere taşımak demek — bugün host'ta koşan tek agent
rolü o.

## Fazlar

### Faz A — volume ve yol soyutlaması

Amaç: yol üretimini tek noktaya toplamak, bind'ı volume'e çevirmek.

- [ ] `resources/` altına **volume kirası** ekle: iş başına named volume adı
      (`ahtapot-job-<jobId>`), tek tahsis otoritesi kuralına uygun.
- [ ] `exec/docker.ts:149` bind → `{ Type: "volume", Source: <volume>, Target: workdir }`.
- [ ] Kaynak workspace için **ikinci mount, salt okunur**:
      `{ Type: "bind", Source: toDockerPath(workspaceRoot), Target: "/source", ReadOnly: true }`.
- [ ] `ContainerSpec.jobDir` sözleşmesi değişir: host yolu değil volume adı.
      Yorumlar ve tip adları buna göre (`jobDir` → `jobVolume`).
- [ ] `agents/transport.ts:154` `toContainerPath()`: `hostRoot` kavramı
      anlamsızlaşır. Ya kaldırılır ya volume mount noktasına sabitlenir.
      **Dikkat:** önek eşleşmezse bugün hata fırlatıyor — sessiz bozulma değil,
      ama testler bunu yakalamalı.

### Faz B — WorktreeManager'ı konteynere taşı

Amaç: `workspace/worktree.ts`'in host fs bağımlılığını kesmek.

Bugün modül baştan sona `node:fs` + host `execFile` kullanıyor
(`cpSync/globSync/rmSync/mkdirSync/statSync/existsSync`, satır 2).

- [ ] `WorktreeManager`'a **executor** enjekte et (mevcut `ContainerExecutor` /
      `HostExecutor` ikilisi — build kapısındaki desenin aynısı). Testler
      `HostExecutor` ile koşmaya devam eder.
- [ ] `git()` helper'ı executor üzerinden koşsun (satır 162).
- [ ] `ensureMirror()`: `existsSync` → konteyner içi `test -d`; `clone --mirror`
      kaynağı `/source` (salt okunur mount).
- [ ] `core.longpaths` ayarı **gereksizleşir** — Linux'ta MAX_PATH yok. Kod
      kalabilir (zararsız) ama yorum güncellenmeli; Windows notu artık tarihsel.
- [ ] `copyIgnoredButNeeded()` / `copyNestedRepos()`: `cpSync` → konteyner içi
      `cp -a` + filtre. `globSync` → `find`/`git ls-files` ya da konteynerde
      koşan küçük bir Node betiği. **Filtre mantığı (`neverCopy` üstünlüğü)
      korunmalı** — bu güvenlik kuralı, kaybı sessiz sızıntı olur.
- [ ] `removeSensitive()`: `rmSync` → konteyner içi `rm -rf`.
- [ ] `remove()`: volume silme. **Not:** bu metot bugün üretimde hiç
      çağrılmıyor (yalnız testte) — temizlik zaten yapılmıyordu. Volume'e
      geçerken `reconcile()`'a bağlamak doğal yer.

### Faz C — git işlemlerini konteynere al

Bugün host'ta koşan git komutları:

| Yer | Komut | Not |
|---|---|---|
| `engine/job.ts:1583` | `commitPhase`: `add -A`, `diff --cached`, `commit` | Safha commit'i |
| `engine/job.ts:1685` | `diffSummary`: `ls-files --others`, `diff --no-index/--stat/HEAD` | Onay kapısı yükü |
| `build/gate.ts:103` | `changedFiles`: `diff --name-only`, `status --porcelain` | Adım seçimi |
| `build/tests.ts:199` | `measureBaseline`: `status`, `stash push/pop` | **En kırılgan** |
| `git/github.ts:52` | `push`, `gh pr create` | Kimlik sorunu — aşağıda |

- [ ] `commitPhase` + `diffSummary` executor üzerinden.
- [ ] `changedFiles` executor üzerinden.
- [ ] `measureBaseline`: stash artık konteynerde. Bugün worktree host'ta
      stash'lenirken testler konteynerde koşuyordu — bu tutarsızlık taşımayla
      **düzeliyor**, bozulmuyor.
- [ ] **Git kimliği:** push ve `gh pr create` host credential'ından besleniyor.
      Konteynerde bu yok. Ya (a) push host'ta kalır — o zaman volume'den
      okuma gerekir, ya (b) token konteynere `options.env` ile verilir (kural 5
      ile uyumlu: `process.env`'e yazılmaz). **(b) tercih edilmeli**, ama
      `gh`'ın konteyner imajında olması gerekir.

### Faz D — tüketicileri düzelt

- [ ] **`build/tests.ts:179` — sessiz bozulma riski.** Test raporunu konteyner
      yazıyor, host `globSync` okuyor. Bind kalkınca dosya bulunamaz ve
      `:180` `return null` ile **hata vermeden** sonuç kaybolur. Okuma
      konteynere alınmalı; ayrıca "rapor yok" durumu artık uyarı üretmeli.
- [ ] `live/compose.ts:27` bind string'i → volume referansı; `environment.ts:298`
      `toComposePath` çağrıları buna göre.
- [ ] `live/environment.ts:332` compose CLI **cwd'si worktree** — `-f` göreli
      yolu oradan çözülüyor. Volume'de host cwd'si yok; compose dosyası ya
      konteynerden okunup host'a geçici yazılır ya compose konteynerde koşar.
- [ ] `live/golden.ts:231` ikinci bind mount → volume.
- [ ] `db/schema.ts:127` `worktree_path` artık volume içi yol. Anlamı
      değişiyor; UI'da (`web/src/api.ts:141`) gösterimi buna göre.
- [ ] `engine/job.ts` dört `runtime.acquire({ jobDir: dirname(worktreePath) })`
      çağrısı — `dirname` ile host yolu türetme kalkar.

### Faz E — Planner'ı konteynere al + sıra tersine

- [ ] `job.ts:290` `prepare()` çağrısı konteyner açıldıktan **sonraya** taşınır.
- [ ] `job.ts:352` Planner `runtime.acquire()` üzerinden koşar.
- [ ] `resume()` (`job.ts:609`) ikinci `prepare()` aynı sırayı izler.

### Faz F — testler

- [ ] `worktree.test.ts` `HostExecutor` ile koşmaya devam (host tmp dizininde),
      böylece Docker'sız ortamda kırılmaz.
- [ ] `docker.test.ts:56` volume kurulumuna göre güncellenir.
- [ ] `job.test.ts` sahte runtime yol varsayımları (satır 166, 211, 283, 329).
- [ ] Yeni test: **volume'de worktree hazırlığı** — Docker varsa koşar, yoksa
      `t.skip()`.

## Riskler

| Risk | Etki | Azaltma |
|---|---|---|
| Test raporu sessizce kaybolur | Yeşil sanılan kırmızı | Faz D ilk madde; "rapor yok" uyarı üretsin |
| `neverCopy` filtresi `cp -a`'ya çevrilirken zayıflar | **Sır sızıntısı** (`.run/` JWT) | Filtre mantığı korunur; mevcut worktree testleri bunu zaten kontrol ediyor |
| `gh`/git kimliği konteynerde yok | PR açılamaz | Faz C son madde; token `options.env` ile |
| Compose cwd'si kaybolur | Canlı ortam kalkmaz | Faz D üçüncü madde |
| Post-mortem zorlaşır | Hata ayıklama yavaşlar | `docker run --rm -v ahtapot-job-<id>:/w alpine sh` yeterli |

## Ölçüm — SONUÇ (2026-09-17)

Gerçek iş: **Sipariş notları** (`01a0a989…`), Northwind, tek safha.

| Aşama | Süre | Kanıt |
|---|---|---|
| Developer turu | 340 s (40 tur, $8,27) | `agent.end` seq 7448 |
| **Build (npm + dotnet)** | **~176 s (2 dk 56 sn)** | `job.state` seq 7452 → 7453 (12:00:25 → 12:03:21) |

**Taşımadan önce aynı build 30 dakikaya çıkıyordu.** Yaklaşık **10× hızlanma**
— beklentinin (5×) üstünde. Teşhis doğruydu: sorun dosyaların Windows NTFS'te
durup her erişimin 9p katmanından geçmesiydi.

Build içeriği doğrulandı: `npm ci` gerçekten koştu (`node_modules` volume'de),
Vite derlemesi ve `dotnet build` tamamlandı, kapı yeşil verdi.

Not: bu ölçüm tam build değil artımlı bir safhanın build'i. Tam build (mirror
klonu dahil) ayrıca ölçülmedi; mirror klonu tek seferlik ve 62 MB.

## Uygulama notları (2026-09-17)

Altı faz da yazıldı; `npx tsc -b` ve `npm run build` temiz. **Testler
koşturulmadı** (insanın işi) ve **gerçek Northwind işiyle ölçülmedi**.

Plandan sapılan ve plan yazılırken bilinmeyen yerler:

| Konu | Ne yapıldı | Neden |
|---|---|---|
| Volume kirası | Ayrı `LeaseKind` eklenmedi | `"worktree"` zaten vardı; kiranın DEĞERİ volume içi yol oldu |
| `toContainerPath` | Kaldırılmadı, konteyner köküne sabitlendi | Kök dışı yol hâlâ hata olmalı; yalnız denetim ölçütü değişti |
| Planner | Konteynere alındı (Faz E) | Host'ta koşan tek roldü; worktree artık host'ta yok |
| QA case turu | O da konteynere alındı | Aynı sebep; planda ayrıca yazılmamıştı |
| `GitHubClient` | İkiye bölündü | `push`/`createDraftPr` worktree ister → yürütücü; `checks`/`failedLogs` GitHub API'sine gider → host'ta kaldı |
| `gh` kimliği | `GH_TOKEN` host'tan okunup çağrı ortamına verildi | Kural 5: `process.env`e yazılmaz, konteynerin kalıcı ortamına girmez |
| Compose base | Volume'den host'a çıkarılıyor (`compose.base.yml`) | Compose CLI host'ta koşuyor, `-f` yolunu host'ta görmeli |
| Compose cwd | Artifact dizini | Worktree host'ta yok |
| `decidePhase` | Commit `developing` promise'ine zincirlendi | Metot senkron kalmalı (çağıran anında durum görüyor), ama commit sıradaki safhadan önce bitmeli |
| `HostExecutor` | `posix` kipi eklendi | Worktree kodu POSIX üretiyor; Windows testleri Git'in `sh`'ını kullanır |
| `reconcile` | Volume temizliği + yetim volume taraması | Konteyner gidince volume kalırsa worktree diskte görünmez biçimde birikir |
| `golden.ts` | `jobId` parametreye eklendi | Volume adı için gerekliydi; yoksa mount edilmez ve adım açıkça düşer |

### Sessiz bozulma noktaları — kapatıldı

1. `build/tests.ts` rapor okuması yürütücüye alındı; **"rapor bekleniyordu ama
   bulunamadı" artık uyarı üretiyor**. Eskiden `null` dönüp sonucu sessizce
   düşürüyordu.
2. `neverCopy` süzmesi `cp -a` sonrası `pruneCopied` ile uygulanıyor —
   kopyalanan ağacın içindeki eşleşmeler ve `.git` siliniyor. Kabuk enjeksiyonu
   için tüm yollar tek tırnakla kaçışlanıyor (`shellQuote`).

### İlk gerçek koşuda çıkan ortam gerçekleri (2026-09-17)

Taşıma sonrası ilk iş (`Sipariş notları`) üç kusuru arka arkaya ortaya çıkardı.
Hiçbiri tip denetiminden geçmezdi — yalnız gerçek Docker'da görünür.

**1. `git`: "detected dubious ownership" — asıl kök neden.**

Kaynak workspace konteynere bind mount edilince dosyaların sahibi host
kullanıcısı oluyor (Windows'ta farklı uid) ve git 2.35+ o dizinde çalışmayı
reddediyor:

```
fatal: detected dubious ownership in repository at '/source'
```

Teşhisi zordu çünkü `clone --mirror` bunun üzerine **boş bir hedef dizin
bırakıp** devam etti; hata iki adım sonra, `worktree add` sırasında
"not a git repository" olarak göründü. Çözüm: hazırlığın başında
`git config --global --add safe.directory '*'` (konteyner tek işe ait,
içindeki her şey aynı işin dosyası).

**2. Varlık kontrolü yeterli değil: geçerlilik gerekiyordu.**

`ensureMirror` mirror'ı `test -e` ile kontrol ediyordu. Yarım kalan klonun
bıraktığı boş dizin bu ölçütü geçiyor ve **sonraki her deneme aynı yerde
düşüyordu** — kalıcı, kendi kendini onarmayan bir durum. Ölçüt
`git rev-parse --git-dir`e çevrildi; yarım klon silinip yeniden kuruluyor.
Klon sonrası ayrıca doğrulanıyor: çıkış 0 tek başına yetmiyor.

**3. Yakalanmamış promise tüm SÜRECİ öldürüyordu.**

`decidePhase`in commit zinciri `runDeveloping`in `try/catch`i dışındaydı.
Eski bir işin host yolu `docker exec`e gidince ("Cwd must be an absolute
path") reddetme yakalanmadı ve **sunucu çöktü**. Artık `fail()` ile işe
yazılıyor: bir işin commit'i düşerse o iş NeedsAttention'a gider, süreç ayakta
kalır.

**4. `workdir` iki segment eksik hesaplanıyordu — en sinsi kusur.**

`DockerRuntime` çalışma dizinini `<root>/<repo>` diye kuruyordu. Bu, worktree
host'tayken doğruydu: `jobDir` zaten `worktrees/<jobId>`e işaret ediyor ve
altına repo adı ekleniyordu. Volume'de kök `/workspace` olunca aradaki
`worktrees/<jobId>` **sessizce düştü** ve kurulum var olmayan
`/workspace/Northwind` dizininde koştu.

Belirti yanıltıcıydı: `npm ci ... (çıkış 127)`. 127 "komut bulunamadı"
demektir, o yüzden ilk şüpheli imajın araç zinciri oldu — oysa `node`, `npm`
ve `dotnet` imajda vardı. Yol ile ağacın düzeni tek kaynaktan gelmiyordu:
`WorktreeManager.worktreePath` `<root>/worktrees/<jobId>/<repo>` üretirken
runtime `<root>/<repo>` varsayıyordu.

Ek olarak `ensureSetup` artık çalışma dizinini ÖNCE yokluyor (`pwd && ls`);
dizin kullanılamıyorsa hata araç zincirini değil yolu suçluyor.

**5. SDK hatasının metni HİÇBİR YERE yazılmıyordu** (taşımadan bağımsız).

`runner.ts` hata metnini yalnız `catch` bloğunda dolduruyordu. Ama SDK hatayı
**fırlatmadan** da bildirebiliyor: `result` mesajı `subtype: "error"` taşır ve
akış normal biter. O yolda `errorMessage` boş kalıyor, DB'ye `status:
"success"` + `stop_reason: "error"` yazılıyor ve insan yalnız
"Developer koşusu bitmedi (error)" görüyordu — teşhis edilemez.

Artık `result` mesajı başarısızsa gövdesi `errorMessage`e giriyor,
`RunResult` onu taşıyor ve motorun beş `... koşusu bitmedi` mesajı sebebi
ekliyor.

**6. Kayıp SDK oturumu kendi kendine çıkamayan bir kilit üretiyordu.**

SDK transcript'leri `CLAUDE_CONFIG_DIR` (`/workspace/.ahtapot/claude`)
altında tutuyor. O dizin taşımadan önce bind mount'taydı, yani Windows
diskinde; volume'e geçince boşaldı. DB'deki `sdk_session_id` ise duruyordu ve
`resume` her denemede aynı ölü oturumu istiyordu:

```
No conversation found with session ID: f9f5d768-…
```

Koşu 2,5 saniyede sıfır turla düşüyor, retry aynı yere çarpıyordu.

Düzeltme: **`resume` bir iyileştirmedir, koşmanın ön şartı değil.** Oturum
bulunamazsa runner BİR KEZ oturumsuz yeniden dener (ikinci kez düşerse sebep
oturum değildir). Transcript artık volume'de, yani konteyner yeniden
kurulsa da kalıcı.

**7. Abonelik "session limit" mesajı kota sayılmıyordu.**

Oturum düzeltmesinden sonra SDK gerçekten koştu ve API'ye ulaştı; bu kez
şunu döndü:

```
You've hit your session limit · resets 11:40am (UTC)
```

`QUOTA_PATTERN` bu ifadeyi tanımıyordu: kota yerine sıradan hata sayılıp
kimlik devri hiç denenmiyordu. Desene eklendi. Ayrıca açılış saati **insan
biçiminde** geliyor (epoch değil), o da ayrıştırılıyor — yoksa anahtar
varsayılan 60 dakika boyunca boşuna dinlenirdi.

İnce nokta: mesaj saniye vermiyor ve hata bize dakikalar sonra ulaşabiliyor.
"resets 11:40" mesajı 11:51'de işlenince toleranssız karşılaştırma bunu
*ertesi gün* sanıp anahtarı 24 saat dinlendiriyordu. 30 dakikalık tolerans
eklendi.

Doğrulandı (dört örnekle): "rate limit konusunu sordu" gibi asistan metni
hâlâ **temiz** kalıyor — kural 6'daki yanlış pozitif tuzağı korunuyor.

**8. Terk edilmiş `live_env` kirası işi kalıcı kilitliyordu** (taşımadan bağımsız).

Compose projesi adı iş başına SABİT (`ahtapot-<jobId>`). Ortam `unhealthy`
kalıp hiç `stop()` edilmezse kira asılı kalıyor ve o iş **bir daha asla**
canlı ortam kaldıramıyor:

```
kaynak zaten kirada: live_env=ahtapot-01a0a989-…
```

08:20'de alınan kira 12:03'teki koşuyu düşürdü — TTL 10:20'de dolmuş
olmasına rağmen. İki ayrı eksik vardı:

- `LiveEnvironments.start()` aynı işin kendi bayat kirasını devralmıyordu.
  Artık devralıyor; **başka** bir işin kirasıysa dokunulmuyor (o zaman
  çakışma gerçektir).
- `reconcile()` süresi dolmuş kiraları hiç toplamıyordu. `expires_at` sütunu
  vardı ama **hiçbir yer okumuyordu**: yalnız bitmiş *işlerin* kiraları
  bırakılıyordu. Açılışta artık süresi geçmiş her kira serbest bırakılıyor.

**9. Taşıma öncesi işler migration istiyordu.**

DB'deki sekiz işin `worktree_path`i host yoluydu. `reconcile()` bunları
tespit edip yolu `null`a çekiyor ve `worktree_migrated` damgasıyla
NeedsAttention'a alıyor — yol YENİDEN YAZILMIYOR, çünkü volume'de o ağaç yok;
yazmak işi "hazır" gösterip daha derin bir hataya götürürdü. `retry()` ağacı
volume'de kuruyor. Zaten NeedsAttention olan işte geçiş yapılmıyor (kendine
geçişi durum makinesi reddeder ve açılış çökerdi).

### Bilinen açık

`WorktreeManager.remove()` üretimde hâlâ çağrılmıyor (taşımadan önce de
öyleydi). Volume temizliği `reconcile()` üzerinden yapılıyor; worktree ağacının
kendisi volume ile birlikte gidiyor.

## Kapsam dışı

- Dış sunucuya taşıma (prod orada; ayrı karar).
- `northwind-shared-runtime` plugin'inin kendi optimizasyonu — taşıma sonrası
  ölçüm hâlâ kötüyse gündeme gelir.
- Ters proxy, çoklu repo worktree (Faz 2/5'te duruyor).
