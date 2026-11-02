# LiveTest'te tarayıcı testi: senaryoları agent çıkarır, koşar, işaretler

Durum: **uygulandı, derlendi; gerçek bir işte denenmedi** (2026-10-15).
Karar özeti: [§41](01-decisions.md).

## Amaç

LiveTest önceden: ortam kalkar → DAST (isteğe bağlı) → insan porttan dener,
senaryo checklist'ini işaretler → onay/red. İnsan her turda listeyi sıfırdan
elle yürüyordu; çoğu mutlu yol ve basit doğrulama mesajı.

**Yeni adım yok.** `live.browserTest` açıkken LiveTest içinde, kapı açılmadan,
DAST gibi otomatik bir ön tur:

1. `tester` senaryoları kendiliğinden çıkarır (liste yoksa),
2. aynı oturumda Playwright MCP ile **tek koşuda** yürütür,
3. checklist'i `source: "agent"` ile işaretler, ekran görüntüsü bırakır.

İnsan kapıda işaretli bir listeyle karşılaşır, yalnız "kaldı"lara ve
şüphelilere bakar. Karar insanındır; tur kapıyı kendisi geçirmez.

## Neden Playwright MCP (browser-use değil)

- Claude tarayıcıyı **kendisi** sürer: ikinci LLM, ikinci anahtar, Python
  yığını yok. Kimlik koşuya zaten `options.env` ile veriliyor (kural 5).
- Erişilebilirlik ağacıyla çalışır; ekran görüntüsü kanıt içindir.
- browser-use'un QA yöntemi cloud tarayıcı + localhost tüneli şart koşuyor;
  Northwind'in canlı ortamı dışarı açılamaz.

## Akış

```
LiveTest: ortam hazır → DAST → (autoFix değilse) senaryo üret → tarayıcıda koş + işaretle → live_test kapısı
                                                   └────────── tester, aynı oturum ──────────┘
```

Kod: `engine/job.ts` `runLiveBrowserTest`, `startLiveTest` içinden.

1. **Koşmama koşulları** — her biri özete `skipped` + sebep yazar, akışa not
   düşer, kapı yine açılır: köprü `browser` yeteneğini bildirmiyor (konteyner
   eski imajdan), senaryo üretimi düştü, koşacak senaryo yok, ağa
   bağlanılamadı, beklenmeyen hata.
2. **Yeniden kullanım.** Son kapının özeti atlanmamışsa ve çalışma ağacı özeti
   (`tree`) aynıysa tur koşmaz; önceki işaretler geçerli (DAST'ın kalıbı).
3. **Senaryo.** En son hazır liste kullanılır (plan onayında ya da önceki
   turda üretilmiş). Yoksa `produceScenarios` (stage `live`) üretir; bu
   üretimin oturumu tarayıcı turunda `resume` edilir — kodu yeniden okumaz.
4. **Kapsam** (`scope`). `pending`: işaretsiz, `retest` ve agent'ın eski
   işaretleri. İnsanın koyduğu işaret yeniden koşmaz. `high`: `pending`in
   yüksek öncelikli olanları. `all`: hepsi.
5. **Ağ.** `LiveEnvironments.attachBrowser`: iş konteyneri uygulamanın
   **edge** ağına bağlanır (`<proje>_<ağ>-edge`), hedef
   `http://<uygulamanın edge IP'si>:<birincil port>`. Servis adı değil IP:
   `app` adı Chrome'un HSTS ön yükleme listesindeki `.app` alanına düşüyor
   ve istek zorla HTTPS'e çevriliyordu. Bağımlılıkların `internal` ağına
   bağlanılmaz. Host portu kullanılmaz: iş konteynerinin içinden `127.0.0.1`
   kendisidir. Ön yüz API'yi başka bir adresten çağırıyorsa profilde
   `baseUrl` verilir. Tur sonunda `finally`de ayrılır; `stop()` de ayırır —
   bağlı konteyner ağın `compose down` ile silinmesini engeller.
6. **Koşu.** Rol `tester`, **canlı kanallı** (insan izler ve yazabilir;
   `onLiveTurn` blok gelince kanalı kapatır). Araçlar: Read/Glob/Grep,
   salt-okunur Bash, `mcp__playwright`. Yazma araçları kapalı. Süre tavanı
   `timeoutMinutes`: dolunca `abortJob`.
7. **Çıktı — üç katman (kural 3).** Agent `SCENARIO_RESULTS_JSON` yazar
   (`ScenarioResultsSchema`). Blok yoksa / şemaya uymuyorsa aynı oturumdan bir
   kez istenir. Yine yoksa ya da bir senaryonun sonucu eksikse o senaryo
   **işaretsiz kalır** ve özette `noResult` sayılır. *Plandan sapma:* plan
   eksikleri `unsure` sentezliyordu; denenmemiş senaryoya "kararsız" yazmak
   yanlış bir iz bırakır, işaretsiz bırakmak insanı ona yönlendirir.
8. **İşaret** (`applyBrowserMarks`). Satır yeniden okunur: tur sürerken insanın
   koyduğu işaret (retest dışı) ezilmez. Not maskelenir ve 2000 karakterle
   sınırlanır.
9. **Kanıt.** MCP iş volume'ünün kökünde `/workspace/.ahtapot/live-<tur>/`
   dizininde başlar (worktree'nin dışı — görüntüler diff'e girmez). Tur
   sonunda `base64` ile `artifacts/<job>/live-<tur>/`e taşınır (≤80 dosya,
   ≤3 MB). İşarette `<tur>/<dosya>`; UI `GET /api/jobs/:id/live-evidence/:tur/:dosya`.
10. **Kapı.** `LiveGatePayload.browserRun: BrowserRunSummary`. Agent "kaldı"sı
    Developer'a kendiliğinden gitmez; insan reddederse mevcut
    `carryScenarioMarks` işaretli "kaldı"ları (agent'ınkiler dahil) taşır.

## Developer'a kararlı seçici kuralı

`renderSelectorNote`: tarayıcı testi açık ve `selectorAttribute` doluysa
Developer prompt'unun her varyantına `<live-test>` notu eklenir (otopilot
notuyla aynı yol — profil iş ortasında açılabilir):

- Eklenen/değiştirilen her input, select, textarea, button, link ve satır
  eylemine anlamlı, kararlı bir kimlik (`order-amount`, `order-save`).
- Tekrar eden satır eyleminde kayıt anahtarı (`order-row-<id>-delete`).
- Görünür etiket input'a bağlı kalır; kimlik etiketin yerine geçmez.
- Formu şemadan üreten bileşende kimlik alan adından bir kez türetilir.

Tarayıcı turu kimliksiz etkileşimli elemanları `missingSelectors`e yazar;
kapıda ayrı liste olarak görünür.

## Profil (`live.browserTest`, varsayılan kapalı)

```ts
browserTest: {
  enabled: false,
  scope: "pending" | "all" | "high",    // varsayılan pending
  baseUrl: "",                           // boş: http://<edge IP>:<birincil port>
  maxTurns: 150,
  timeoutMinutes: 30,
  viewport: "1440x900",
  evidence: "screenshot" | "none",
  selectorAttribute: "id",               // boş: Developer'a not yok
  accounts: [                            // rol bazlı test hesapları
    { role: "yönetici", description: "Tüm modüller", credentials: { ADMIN_USER: "...", ADMIN_PASSWORD: "..." } },
    { role: "bayi", description: "Yalnız kendi siparişleri", credentials: { BAYI_USER: "...", BAYI_PASSWORD: "..." } },
  ],
}
```

**Hesaplar rol bazlı** (2026-10-18, insan talebi). Senaryo üretimine yalnız
rol + açıklama gider; tester planla eşleştirip senaryonun `account`ına rolü
yazar. Tarayıcı turu senaryoları hesaba göre gruplar, hesap değişince çıkış +
giriş yapar. Sırlar tek dotenv'de birleşir: sır adı hesaplar arasında tekil
(şema reddeder). Eski düz `credentials` tablosu okurken `varsayılan` rollü tek
hesaba çevrilir (`upgradeBrowserCredentials`).

Model: `agents.roles.tester` → yoksa `qa`.

**Giriş bilgisi profilde** (karar). Agent yalnız adları görür ve alana adı
yazar; Playwright MCP `--secrets` ile gerçek değeri koyar ve yanıtlarda değeri
`<secret>AD</secret>` ile maskeler (0.0.83 kaynağında doğrulandı:
`lookupSecret`/`redactSecrets`). Değerler ayrıca `registerSecretValues` ile
`scrubSecrets`e eklenir (≥6 karakter). Profil düzenleyicide mevcut `EnvTable`
kuralı geçerli: adında PASSWORD/SECRET/TOKEN/KEY geçen değer gizli girişle
gösterilir — bu yüzden parola adı `UI_PASSWORD` gibi olmalı. *Plandan sapma:*
profil API'sinde ayrı maskeleme yapılmadı; diğer profil sırlarıyla aynı düzen.

## Köprü ve imaj

- Agent taban imajı: `@playwright/mcp@0.0.83` `/opt/playwright-mcp`e,
  `playwright install --with-deps chromium` (`PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`).
  İmaj ~400 MB büyür; parmak izi değiştiği için taban ve proje imajları ilk
  açılışta yeniden kurulur. *AVG TLS taraması indirmeyi kırabilir (yaşandı).*
- Köprü 0.3.0: MCP dosyası varsa `browser` yeteneğini bildirir. `run.start`
  `browser` alanı (`BrowserRunConfigSchema`) varsa `mcpServers.playwright`:
  `--headless --browser chromium --isolated --output-dir … --allowed-origins …
  --viewport-size … --test-id-attribute … --secrets …`. Sırlar `0600` dotenv
  dosyasına yazılır, koşu bitince silinir. dotenv kaçış tanımadığı için değer
  içinde geçmeyen bir tırnakla sarılır.
- Sunucu `ContainerTransport.supports("browser")` ile sorar; eski köprüye
  alan gönderilmez (eski köprü alanı sessizce atıp tarayıcısız koşardı).
- `--allowed-origins` MCP belgesine göre güvenlik sınırı **değil**; dış
  kökenleri süzen bir gürültü filtresi. Sınır konteyner ve ağ.
- MCP 0.0.83'te trace bayrağı yok; kanıt yalnız ekran görüntüsü.

## Dayanıklılık

- Tur sürerken faz `LiveTest/running`; kapı açılınca `waiting`. Sunucu
  ortada düşerse mevcut `reconcile` LiveTest'i yarıda kalmış sayar; ağ
  bağlantısı `stop()`ta koparılır. *Plandan sapma:* ayrı bir "yarıda kaldı"
  kapı notu yazılmadı.
- Meşgul işareti tur boyunca tutulur (yoksa alınır, sonunda bırakılır):
  "Yeniden kaldır" yolu işareti tutmadan geliyor, bu arada istenen senaryo
  üretimi köprüde "busy" ile düşerdi.

## UI

- Senaryo listesi: agent işaretine `🤖 agent` rozeti, kanıt küçük resimleri;
  agent işaretinde aynı düğme **benimser** (kaynak insan olur), ikinci basış
  kaldırır.
- Kapı kartı: DAST'ın altında "Tarayıcı testi" özeti, atlanma sebebi,
  kimliksiz elemanlar.

## Açık kalanlar

- Gerçek bir işte deneme: imaj kurulumu (AVG), edge ağına bağlanma, Northwind
  panelinin API çağrılarının iç adresten çalışıp çalışmadığı (`baseUrl`
  gerekebilir), oturum `resume`unun üretim → tarayıcı turunda tuttuğu.
- Northwind profilinde `live.browserTest` açılmadı.
- `autoFix` (agent "kaldı"sıyla kapı açılmadan düzeltme) yok; ölçmeden açmak
  bütçe yakar.
- Test yazılmadı.
