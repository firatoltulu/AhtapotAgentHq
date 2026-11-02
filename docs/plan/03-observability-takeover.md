# İzleme ve Devralma — tasarım

**Durum:** onaylandı ve UYGULANDI (2026-09-17). Tampon tavanı ve yetim koşu
sınırı insan onayıyla belirlendi. Ölçümler çalışan kurulumdan.

**Uygulanma özeti** — hepsi derlendi, tip kontrolü temiz:

| Adım | Nerede |
|---|---|
| A1+A2 `build.log` ephemeral | `ws/hub.ts` `EPHEMERAL_TYPES` |
| A3 build log REST ucu | `api/jobs.ts` `/builds`, `/builds/:id/log` |
| A4 istemcide ayrı kanal | `web/src/ws.ts` `buildLines`, `JobDetail.tsx` |
| B1 token kalıcı (SHA-256) | `db/schema.ts` `bridgeTokens`, `exec/bridge.ts` |
| B4 `sdkSessionId` erken yazım | `agents/runner.ts` `system` mesajında |
| B2 köprü kopmada KESMEZ | `bridge/main.ts` `onclose` |
| B3 devralma protokolü | `shared/ws.ts` `activeRunId`, `run.attach` |
| B5 sunucu devralır | `engine/job.ts` `takeOver`, `app.ts` hello |

Ayrıca profil **v11** yazıldı: `build.when: "final-phase"`.

**Test yazılmadı** — kullanıcı tercihi (bkz. `CLAUDE.md` § Test).
Doğrulama tip kontrolü ve `npm run build` ile yapıldı; canlı doğrulama
sunucu yeniden başlatıldığında yapılacak.

İki ayrı kusur, tek belgede: agent'ın ne yaptığı izlenemiyor, ve sunucu yeniden
başlayınca konteynerde koşan agent kesiliyor. İkisi bağımsız uygulanabilir.

---

## A. İzleme: build logu agent akışını boğuyor

### Ölçüm

Çalışan kurulumdaki 28.303 olayın dağılımı:

| Tip | Adet | Bayt | Pay |
|---|---|---|---|
| `build.log` | 26.404 | 10,82 MB | **%93 / %87** |
| `agent.tool_use` | 1.153 | 0,45 MB | %4 |
| `agent.message` | 310 | 0,80 MB | %1 |
| `job.state` | 273 | 0,04 MB | %1 |
| diğer (start/end/error/approval/question) | 163 | 0,34 MB | %1 |

Büyük işlerde oran daha keskin: Collection yapısı %97,9 · Sevkiyat %96,8 ·
Sipariş notları %97,1.

### Kusur

Sekmeler UI'da **zaten ayrı** (`JobDetail.tsx:46`): `StreamTab` build logunu
filtreliyor (`:398`), `BuildTab` kendi kutusunda gösteriyor (`:620-666`).
Ayrım yalnız **render katmanında**; veri yolu ortak.

İlk abonelikte sunucu son `REPLAY_LIMIT = 250` olayı gönderiyor
(`hub.ts:194-198`). O 250'nin ~%97'si `build.log`. Akış sekmesi filtreleyince
elinde ~17 olay kalıyor — 38 dakikalık bir Developer turunun görünen kısmı bu.

Üç yan etki, aynı kökten:

1. **`build.log` DB'ye yazılıyor ve `seq` tüketiyor.** `EPHEMERAL_TYPES`
   yalnız `agent.delta` içeriyor (`hub.ts:51`). Kural 7 hacimli akışı DB'den
   çıkarma ilkesini koymuş; build logu o ilkenin dışında kalmış.
2. **Backpressure build logunu atlamıyor.** `hub.ts:149` yalnız ephemeral
   olayları atlıyor; yavaş istemcide tüm build satırları buffer'a yığılıyor.
3. **İstemcide `stream.events` sınırsız büyüyor.** `slice(-250)` görüntüyü
   kısıyor, belleği değil; her build satırı tüm ağacı yeniden render ediyor.

### Karar: `build.log` ana akıştan çıkar, kendi kanalına geçer

Log **zaten dosyada**: `gate.ts:202-205` her adımı
`<artifactsDir>/<jobId>/build-<buildId>.log` altına yazıyor ve `builds.logRef`
onu işaret ediyor. Yani veri korunuyor; DB'deki 10,82 MB kopya fazlalık.

**A1. `build.log` ephemeral olur.** `EPHEMERAL_TYPES`e eklenir. DB'ye
yazılmaz, `seq` tüketmez. Canlı yayın sürer — koşan build'i izlemek çalışır.
Replay penceresi agent olaylarına kalır: 250 olay artık 250 *anlamlı* olay.

**A2. Backpressure build logunu da atlar.** `hub.ts:149` koşulu ephemeral
tanımına bağlı olduğu için A1 ile kendiliğinden gelir.

**A3. Build sekmesi dosyadan okur.** Bitmiş build'ler `builds.logRef`
üzerinden tam dosyayı gösterir; koşan build canlı olayları alır. Bugün
kaybolan "eski build'in logu" böylece geri gelir — şu an 250 satır sonrası
DB'de olsa bile UI'a ulaşmıyor.

Gereken: build logunu okuyan bir REST ucu. `artifacts` tablosunda
`type: "build_log"` **zaten tanımlı** (`schema.ts:395`) ama gate oraya kayıt
yazmıyor — `gate.ts:250-262` yalnız `builds.logRef` sütununu dolduruyor.

**A4. İstemcide build satırları ayrı state'e.** `web/src/ws.ts:64-69` içinde
`build.log` `events` dizisine girmesin; `agent.delta` için var olan ayrı yol
(`ws.ts:58-61`) örnek alınır. Böylece build satırı `StreamTab`ı yeniden
render etmez.

### Takas

`build.log` DB'den çıkınca **replay'de geçmiş build satırı gelmez**. Karşılığı
A3: dosya tam logu taşıyor ve artık erişilebilir. Bugünkü durumda zaten son
250 satırdan öncesi UI'a ulaşmıyordu; A3 ile tam log erişilebilir hâle
geliyor, yani net kazanç.

`elapsed` alanı (`ws.ts:118`) ve dosyadaki `[m:ss.d]` damgası korunur.

---

## B. Devralma: sunucu restart'ı konteynerdeki agent'ı öldürüyor

### Kusur zinciri

Beş nokta, sırayla:

| # | Yer | Sorun |
|---|---|---|
| 1 | `bridge/main.ts:215-218` | Soket kapanınca köprü koşuyu **kendisi kesiyor** (`q.interrupt()`). 2 saniyelik restart 38 dakikalık turu öldürüyor. |
| 2 | `exec/bridge.ts:133-137` | Köprü token'ı **yalnız bellekte**. Restart → token kaybolur → ayakta kalan köprü doğrulanamaz. |
| 3 | `shared/ws.ts:208-290` | Protokolde devralma yok: `bridge.hello`'da aktif `runId` yok, `seq` yok, re-subscribe yok. |
| 4 | `agents/runner.ts:321-327` | `sdkSessionId` DB'ye **koşu bitince** yazılıyor. Ortada ölen tur resume edilemez. |
| 5 | `engine/reconcile.ts:55-72` | Açılışta `starting`/`running` her iş **koşulsuz** `NeedsAttention`. Köprüye "canlı mısın" diye sorulmuyor. |

Bugünkü sonuç (`runtime.ts:56-68`): restart sonrası köprü eski token'la
bağlanıyor, reddediliyor, 30 sn'de bir deniyor; `acquire` 60 sn sonra düşüyor.
Çözüm olarak konteyner "bayat" sayılıp siliniyor. Yani konteyner
`KEEPS_CONTAINER` sayesinde korunuyor ama içeriği kullanılamıyor.

### Karar: koşu sunucudan bağımsız yaşar

Sıra bağlayıcı — her adım öncekine dayanıyor.

**B1. Token kalıcı olur.** `agent_runs` ya da yeni bir `bridge_tokens`
tablosunda token'ın **hash'i** saklanır (ham token değil; kural 4). Restart
sonrası `attach` DB'den doğrular. Bu yapılmadan diğer adımlar anlamsız:
köprü bağlanamıyorsa devralınacak bir şey yok.

**B2. Köprü kopmada kesmez.** `main.ts:215-218`'deki `q.interrupt()` +
`channel.end()` kaldırılır. Koşu sürer, üretilen `bridge.event`'ler **tamponda
birikir**.

Tampon tavanı: en uzun ölçülen tur **38 dakika / 25 tur**. Tavan olay sayısı
ile konur (öneri: 10.000 olay ≈ birkaç MB). Taşarsa **en eskiler atılır** ve
devralmada "N olay atlandı" işareti gönderilir — koşu kesilmez. Sessiz kayıp
olmaz; kural 3'ün ruhu: üretici taraf güvenilmez, eksiklik görünür olmalı.

**B3. Protokole devralma eklenir.** `bridge.hello`ya `activeRunId` ve
`bufferedFrom` alanları; `bridge.event`e `seq`. Sunucu `run.attach { runId,
sinceSeq }` ile devralır, köprü tampondan devam eder. UI tarafındaki
`sinceSeq` replay mantığının (`ws.ts:42`) köprü kanalına taşınması.

**B4. `sdkSessionId` erken yazılır.** `runner.ts:152` civarında `system`
mesajından öğrenilir öğrenilmez `agent_sessions`a UPDATE. Koşu ortasında ölen
sunucu sonrası resume mümkün olur.

**B5. `reconcile` konteyneri yoklar.** `starting`/`running` işlerde önce
köprüye bağlanılır: `bridge.hello` `activeRunId` bildiriyorsa akış devralınır
ve iş **durumunda kalır**. Bildirmiyorsa bugünkü davranış (`NeedsAttention`)
sürer.

Kural 2 bunu **engellemiyor**: "sonuç yazılmadan çöken bir süreç sessizce
çalışıyor görünmemeli" diyor. Asıl mesele *sessizce*. Köprüye sorup "evet,
`runId` hâlâ koşuyor" cevabını almak ölçülmüş gerçektir, varsayım değil.
`agent_runs.status`ta tanımlı ama hiç yazılmayan `interrupted` değeri burada
anlam kazanır: devralınamayan koşu `error` değil `interrupted` olur.

### Takas

Köprü artık sunucusuz da koşuyor: konteyner CPU ve kota harcamaya devam eder,
sunucu hiç dönmezse bu israftır. Sınır: tampon tavanı dolduğunda **ve** belirli
bir süre (öneri: `askTimeoutMinutes` ile aynı ölçek) bağlantı gelmezse köprü
kendi kendini kapatır. Sonsuz yetim koşu olmaz.

---

## Uygulama sırası

**A önce.** Daha küçük, köprü imajını yeniden derlemeyi gerektirmiyor, ve B'yi
doğrulanabilir kılıyor: devralmanın çalıştığını görmek için agent'ın ne
yaptığını görebilmek gerekiyor.

A içinde: A1+A2 tek değişiklik (bir satır + backpressure kendiliğinden), A4
istemci tarafı, A3 REST ucu + gate'in artifact kaydı.

**B sonra**, sırayla B1 → B4 → B2 → B3 → B5. B1 ve B4 tek başlarına da değerli:
token kalıcı olunca `runtime.ts`'in konteyner silme yolu gereksizleşir.

## Profil etkisi

Hiçbiri profil alanı istemiyor — ikisi de "her proje için doğru" kategorisinde.
Tampon tavanı ve köprünün kendi kendini kapatma süresi motor sabiti olur;
proje tercihi değil, kaynak koruması.
