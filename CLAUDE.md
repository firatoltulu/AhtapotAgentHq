# AhtapotAgent — çalışma kuralları

Çok-agent'lı, canlı etkileşimli bir geliştirme orkestratörü. Kullanıcı UI'dan iş
girer; Planner plan üretir, insan onaylar; Developer geliştirir; build edilir;
canlı ortam ayağa kalkar ve insan porttan test eder; QA test yazar; PR açılır;
DevOps CI'ı takip eder. Her aşamada insan agent'la **koşarken** konuşabilir.

**Ad geçicidir.** `packages/shared/src/brand.ts` tek kaynaktır; ad değişirse
yalnız o dosya düzenlenir.

## Belgeler

| Dosya | Ne |
|---|---|
| [`docs/plan/00-master-plan.md`](docs/plan/00-master-plan.md) | Onaylı ana plan: mimari, durum makinesi, fazlar, riskler |
| [`docs/plan/01-decisions.md`](docs/plan/01-decisions.md) | Kararlar ve gerekçeleri — "neden böyle" sorusunun cevabı |
| [`docs/plan/02-status.md`](docs/plan/02-status.md) | Ne bitti, ne sırada |

**Önce bu üçünü oku.** Plan onaylıdır; ondan sapacaksan gerekçesini yaz ve
kullanıcıya sor.

## Temel ilke

> **Motor yetenek sunar, profil hangisinin geçerli olduğunu söyler.**

Hedef projenin çalışma disiplini (safha onayı, commit politikası, review'ın dış
süreç olması, koşullu derleme) motora **gömülmez** — `ProjectProfileSchema`
alanlarına girer. Proje-agnostiklik iddiasını gerçek kılan budur.

Yeni bir davranış eklerken sor: *bu her proje için doğru mu, yoksa bu projenin
tercihi mi?* İkincisiyse profile alan ekle.

## Mimari sınırlar

```
packages/shared   Zod şemaları — DB tipi, REST gövdesi, WS olayı, agent çıktısı TEK kaynaktan
packages/server   Fastify + WS + Drizzle + SDK sürücüsü (modüler monolit)
packages/web      React UI (henüz yok)
packages/bridge   Konteyner içi WS köprüsü (henüz yok)
agents/core       Proje-agnostik rol promptları
projects/<slug>   Proje-özel overlay, kural ve beceriler
```

- `engine/` Docker'ı bilmez — `exec/` arayüzünü çağırır.
- `agents/` durum makinesini bilmez.
- `resources/` **tek kaynak tahsis otoritesidir**; hiçbir modül kendi başına
  port/DB/worktree seçmez.
- Modüller arası her mesaj Zod ile tanımlıdır.

## Değişmez kurallar

**1. Durum yalnız `engine/transition.ts` üzerinden değişir.** `jobs.state` alanına
doğrudan yazılmaz. Geçersiz geçiş reddedilir; durum ve denetim izi aynı
transaction'da yazılır.

**2. Yeni duruma girerken faz `starting`.** Önce niyet yazılır, sonra iş yapılır.
Açılışta `starting` görülen iş yarıda kalmıştır. Sonuç yazılmadan çöken bir süreç
sessizce "çalışıyor" görünmemeli.

**3. Üretici taraf güvenilmezdir.** Agent'ın ürettiği her yapılandırılmış çıktı
üç katmandan geçer: agent yazar → orkestratör eksikse sentezler → tüketirken Zod
doğrular. LLM'in bloğu hiç yazmaması gerçek ve sık bir senaryodur.

**4. Sır maskeleme pazarlık konusu değil.** DB'ye ya da WS'e giden her metin
`scrubSecrets`ten geçer. Log'lar hem saklanıyor hem UI'da gösteriliyor.

**5. Kimlik `process.env`'e yazılmaz.** Her `query()` çağrısına `options.env` ile
ayrı verilir — paralel işler birbirinin kimliğini ezer. Konteyner daima **tek**
anahtar görür; havuz dosyası mount edilmez.

**6. Kota imzası yalnız hata nesnesinde ve `result` mesajında aranır.** Asistanın
ürettiği metinde ASLA — "rate limit" konulu bir iş kendi metniyle yanlış pozitif
üretir ve anahtarı boşuna dinlenmeye alır.

**7. `agent.delta` DB'ye yazılmaz.** Token akışı hacimlidir; replay'de yerini
tamamlanmış `agent.message` alır. Backpressure'da da aynı ayrım: yavaş istemcide
delta atlanır, nihai mesaj her durumda gider.

**8. Onay kapıları kodla korunur.** Profil onaylanmadan hiçbir iş o profille
koşmaz; `activeProfile()` taslak profili döndürmez.

## Kod tarzı

- **TypeScript strict**, `noUncheckedIndexedAccess` ve `exactOptionalPropertyTypes`
  açık. `any` yok; bilinmeyen veri `unknown` + Zod.
- **ESM**, `.js` uzantılı import (NodeNext).
- Yorumlar **niçin**i anlatır, neyi değil. Ölçülmüş bir gerçeği (yaşanmış hata,
  süre, davranış) not et; bariz olanı tekrarlama.
- Yorum ve belgeler **Türkçe**.

## Test

> **Testleri agent KOŞMAZ.** `npm test` insanın komutudur. İstenmedikçe test
> yazılmaz da. Tip kontrolü (`npx tsc -b`) ve `npm run build` serbesttir —
> değişikliğin derlendiğini doğrulamak için onlar kullanılır.

`node:test` + `node:assert/strict`. Her paket kendi `*.test.ts`'ini taşır.

```bash
npm test -w @ahtapot/shared   # insan koşar
npm test -w @ahtapot/server   # insan koşar
npm run build                 # tüm paketler — agent bunu koşabilir
```

## Çalıştırma

```bash
npm run dev              # derle + sunucuyu izleyerek koş (7717)
npm run dev:build -w @ahtapot/server   # ayrı terminal: kaynağı izleyip derle
npm run dev -w @ahtapot/web            # UI geliştirme (5180, API/WS proxy)
```

Sunucu üç ortam değişkeni ister; **ikisi karıştırılmamalı**:

| Değişken | Ne |
|---|---|
| `AHTAPOT_KEYS` | Claude anahtar dosyası (satır başına bir anahtar) |
| `AHTAPOT_DATA` | worktree, mirror, artifact kökü |
| `AHTAPOT_DB` | SQLite dosyası — **`AHTAPOT_DATA`'dan ayrı** |

İsteğe bağlı `AHTAPOT_REVIEW_KEYS`: yerel ön inceleme (OCR) anahtarları,
satır başına `ad=anahtar`. Claude havuzundan ayrıdır (bkz. kararlar §20).

`AHTAPOT_DB` verilmezse sunucu sessizce `./data/ahtapot.sqlite` açar: işler
görünmez, ekran boş gelir (yaşandı).

`dev` betiği `dist/`i izler, kaynağı değil: ESM/NodeNext gereği importlar `.js`
uzantılı ve `--experimental-strip-types` bu yüzden kaynaktan koşamaz
(`Cannot find module .../app.js`).

İzleme `packages/server/scripts/dev.mjs`te, `fs.watch` ile yalnız sunucu ve
shared `dist/`i. Node'un kendi izleyicisi kullanılmıyor: düz `--watch`
`node_modules`'i de izliyordu (başka bir `npm install` yürüyen imaj
build'ini kesti), `--watch-path=dist` ise Windows'ta `.git/index.lock`a
tepki verip sunucuyu her açılışta yeniden başlattı (ikisi de yaşandı).

**Test yazma ölçütü:** testin bir kusuru yakalayabilmesi gerekir. Bugüne kadar
üç gerçek kusur testlerle yakalandı (JSON sütun varsayılanları, `Omit`'in
discriminated union'da dağılmaması, `uuid` export adı) — bunlar süs değil.

Dış bağımlılık gerektiren testler (gerçek Northwind workspace'i gibi) yoksa
`t.skip()` ile atlanır, kırılmaz.

## Veritabanı

SQLite bugün, PostgreSQL yarın. Taşınabilirlik kuralları **bağlayıcı**:

| Kural | Neden |
|---|---|
| PK **TEXT UUIDv7** | Zaman sıralı → index dostu; SQLite/PG farkı yok |
| Zaman **TEXT ISO-8601 UTC** | Leksikografik sıra = kronolojik sıra |
| Boolean **INTEGER 0/1** | SQLite gerçeği (`mode:"boolean"`) |
| JSON **TEXT + `$type` + `$defaultFn`** | `.default("{}")` ham SQL yazar, okurken çözülmez |
| Para **INTEGER mikro-dolar** | Float para asla |
| ENUM yok — **TEXT + Zod union** | PG enum'ları migration'da baş belası |

Şema değişince: `npm run db:generate -w @ahtapot/server`.

drizzle-kit `Cannot find module 'esbuild'` derse: **lockfile kusuru** —
drizzle-kit `esbuild ^0.25.4` istiyor ama lockfile'da kök `node_modules/esbuild`
kaydı yok (#85/#89'daki override değişikliklerinden kalma); tek kopya
`tsx`in altındaki 0.28. Asıl çözüm lockfile'ı düzeltmek (ayrı iş). O yapılana
dek geçici yol: `NODE_PATH=<kök>/node_modules/tsx/node_modules`. Sürüm
drizzle-kit'in aralığı DIŞINDA; migration üretimi bununla çalıştı
(2026-10-17, `0022`) ama garanti değil — üretilen SQL'i gözle denetle.

## Hedef proje: Northwind

İlk kullanıcı, sistemin parçası **değil** — dışarıdan
bağlanır. Ondan öğrenilen ve motoru şekillendiren gerçekler
[`docs/plan/01-decisions.md`](docs/plan/01-decisions.md) içinde.

Kısaca: tek repo (.NET 10 + React), `main` dalı, `Northwind.Forms` **nested repo**
(submodule değil, remote'u yerel disk yolu), `.run/` **canlı JWT token taşıyor**,
`CLAUDE.md` 476 KB, build sırası bağlayıcı (npm → dotnet, tersi sessizce bozuk
çıktı üretir), `-c Release` yasak (private feed → 401).
