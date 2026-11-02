# Şablon DB — golden volume yerine `CREATE DATABASE ... TEMPLATE`

**Durum:** onaylandı (2026-09-18), uygulanıyor.

## Neden değişiyor

Golden bugün şunu yapıyor: ayrı bir ağda Postgres kaldır → `dotnet run -- --migrate=true`
→ `--install=true` → sonucu bir Docker volume'ünde sakla. Her iş o volume'ü
**1,4 GB kopyalayarak** kendi DB'sini alıyor.

İki kusur ölçüldü (2026-09-18):

**1. Migrate komutu sadece migration koşmuyor.** `dotnet run --project Northwind.Host`
tüm uygulamayı ayağa kaldırıyor: `Program.cs` sırayla Serilog'u kuruyor
(Elasticsearch ister), Redis'i bağlıyor, static web assets'i açıyor. Golden ise
yalnız Postgres kaldırıyordu — uygulama `Program.cs:42`'de Elasticsearch'e
bağlanamayıp **çıkış 134** ile düştü.

Golden "sadece DB lazım" varsayımıyla yazılmış; komut tüm ortamı istiyor.

**2. Volume kopyalamak pahalı.** §11d'de ölçülen desenin aynısı: bind-mount'tan
konteyner diskine 1,4 GB kopyalamak, oraya kurmaktan uzun sürüyordu. Aynı bedel
burada her iş için ödeniyor.

## Karar: tek Postgres, şablon DB, `TEMPLATE` ile klon

Postgres'in kendi mekanizması volume kopyalamanın yerini alır:

```
CREATE DATABASE northwind_job_<id> TEMPLATE northwind_golden;
```

Bu sunucu içi sayfa kopyasıdır — saniyeler sürer, 1,4 GB ağdan/diskten geçmez.

### Akış

```
compose up -d  (postgres + redis + elastic; app HENÜZ başlamaz)
  ↓  postgres sağlıklı (healthcheck)
şablon var mı?   psql -lqt | grep northwind_golden
  hayır → app'i MIGRATE MODUNDA koştur (tüm bağımlılıklar zaten ayakta)
          → migrate + install → şablonu `northwind_golden` olarak bırak
  evet  → atla
  ↓
CREATE DATABASE northwind_job_<id> TEMPLATE northwind_golden
  ↓
app'i başlat: DataSettings__DataConnectionString → job DB'si
  ↓
127.0.0.1:<hostPort>:5080
```

Bugünkü tıkanma kendiliğinden çözülür: şablon kurulurken Redis ve Elasticsearch
**zaten ayakta**, çünkü aynı compose ortamındalar.

### Bağlantı dizesi

Northwind DB'yi `DataSettings:DataConnectionString` altından okuyor
(`appsettings.json.example:105-106`). .NET'in ortam değişkeni override'ı ile
iş başına ezilir:

```
DataSettings__DataConnectionString=Host=postgres;Database=northwind_job_<id>;Username=postgres;Password=…
```

`Host=postgres` — compose ağında servis adı. Host portu yalnız uygulama için
yayınlanır; Postgres dışarı açılmaz.

### Şablon ne zaman tazelenir

Otomatik tazeleme **yok**. Var olan şablon yaşına bakılmadan kullanılır;
orkestratör yalnız kendi yarım bıraktığı şablonu siler.

Eskiden `goldenMaxAgeDays`ı aşan şablon silinip yeniden kuruluyordu. Kaldırıldı
(2026-10-17): şablon yalnız klonların kaynağı, silinmesi için sebep yok. Elle
kurulup `IS_TEMPLATE true` işaretlenmiş şablonda Postgres silmeyi reddetti
(`cannot drop a template database`) ve canlı ortam kalkmadı.

Elle tazeleme: şablonu düşür (`IS_TEMPLATE true` ise önce `ALTER DATABASE ...
IS_TEMPLATE false`), sonraki iş yeniden kurar. Migration ya da seed
değiştiğinde bu tazeleme **zorunludur**: var olan şablon migrate/seed koşmadan
klonlanır, yapılmazsa işler eski şemayla açılır.

### Aynı anda iki iş

`CREATE DATABASE ... TEMPLATE` kaynak DB'ye **aktif bağlantı istemez**. Şablona
kimse bağlanmadığı sürece sorun yok: uygulama hep `northwind_job_<id>`'ye bağlanır,
`northwind_golden`'a yalnız kurulum anında yazılır.

İlk iş şablonu kurarken ikinci iş beklemeli — yoksa ikisi birden kurar. Kilit
`resource_leases` üzerinden (`kind: "golden_template"`), tek tahsis otoritesi
kuralına uygun.

## Test takımları da aynı şablondan (2026-10-13, kararlar §37)

Klon ayarı `live.cloneDb`'den `database.clone`'a taşındı; servisler üst düzey
`services` kataloğunda. `test.suites[].cloneDb` açık takım her koşuda
şablondan kendi klonunu alır (`live/suiteDb.ts`) ve koşu bitince düşürür.
Şablonu yalnız canlı ortam kurar; test tarafı yoksa hata verir.

## Ne kalkıyor

`golden.ts`'in volume tarafı: `goldenVolumeName`, `clone()`, `jobDbVolumeName`,
ayrı golden ağı, ayrı Postgres konteyneri, `removeJobVolume`. Yerine
`templateDb.ts`: şablon var mı, kur, klonla, düşür.

`dbDependency()` kalır — hangi servisin DB olduğunu bilmek yine gerekiyor.

## Takas

**Kazanç:** tek ortam kurma yolu (iki değil), volume kopyalama yok, şablon
kurulumu tüm bağımlılıklarla koşuyor.

**Bedel:** Postgres artık paylaşımlı. Bir işin DB'sini bozması diğerini
etkilemez (ayrı database'ler) ama sunucuyu çökertmesi etkiler. Bugün her işin
kendi konteyneri vardı; o izolasyon azalıyor. Karşılığında canlı ortam gerçekten
çalışıyor.
