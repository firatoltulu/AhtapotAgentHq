# AhtapotAgent

Çok-agent'lı, **canlı etkileşimli** geliştirme orkestratörü.

```
proje bağla → Analyst analiz eder → profil onayı → proje imajı build
  ↓
iş gir → Planner plan üretir → tartış + onayla
  → Developer geliştirir (safhalı) → build → canlı ortam, porttan test et
  → QA case listesi sunar, onayla → testler → PR onayı → PR
  → DevOps CI'ı takip eder → Done
```

Farkı: agent **koşarken** onunla konuşabilirsin. İş başladıktan sonra yön
verebilir, plana itiraz edebilir, canlı ortamı kendi tarayıcından test edip
"şurası yanlış" diyebilirsin.

Proje-agnostik: hedef proje dışarıdan bağlanır ve kendi çalışma disiplinini
*profil* olarak getirir. **Motor yetenek sunar, profil hangisinin geçerli
olduğunu söyler.**

> **Ad geçici.** `packages/shared/src/brand.ts` tek kaynaktır.

- Kullanıcı tarafı (UI'da adım adım): [`docs/kullanim-kilavuzu.md`](docs/kullanim-kilavuzu.md)
- Çalışma kuralları (agent ve geliştirici): [`CLAUDE.md`](CLAUDE.md)

---

## İçindekiler

1. [Sistem gereksinimleri](#sistem-gereksinimleri)
2. [Yerel kurulum](#yerel-kurulum)
3. [Ortam değişkenleri](#ortam-değişkenleri)
4. [Proje bağlama (akış)](#proje-bağlama-akış)
5. [Sunucuya kurulum (Docker)](#sunucuya-kurulum-docker)
6. [Geliştirme](#geliştirme)
7. [Sorun giderme](#sorun-giderme)
8. [Mimari ve belgeler](#mimari-ve-belgeler)
9. [Yol haritası](#yol-haritası)

---

## Sistem gereksinimleri

| Bileşen | Sürüm / not |
|---|---|
| **Node.js** | `>= 22` (sunucu imajı Node 24 kullanır) |
| **npm** | Node ile gelen; repo npm workspaces monoreposu |
| **Docker** | Docker Desktop (Windows/macOS, WSL2) ya da Linux'ta Docker Engine + `docker compose` eklentisi |
| **git** | Hedef repoyu klonlamak, worktree ve push için |
| **GitHub CLI (`gh`)** | PR, push, issue ve repo listesi için. Yerelde `gh auth login` yeterli; Docker'da `GH_TOKEN` zorunlu |
| **Claude kimliği** | Pro/Max aboneliği için `claude setup-token` ile üretilen `sk-ant-oat…` token'ı **ya da** Console API anahtarı |

**Docker neden zorunlu?** Her agent kendi sandbox konteynerinde koşar; canlı
ortam `docker compose` ile ayağa kalkar; proje imajı ve agent taban imajı
Docker'da build edilir; worktree'ler adlandırılmış volume'de (`ahtapot-job-<id>`)
tutulur. Docker yokken sunucu açılır, profil/plan/onay ekranları çalışır ama
Developer ve canlı ortam adımları düşer.

**Kaynak ve ağ**

- Agent taban imajı ~1 GB; proje imajı hedef projenin araç zinciri kadar büyür.
  Her iş kendi worktree volume'ünü alır — disk payı bırakın.
- Docker daemon'ı Docker Hub, npm ve github.com'a çıkabilmeli (imaj build'i).
- Portlar:

| Port | Ne |
|---|---|
| `7717` | API + WebSocket + derlenmiş UI |
| `5180` | Vite geliştirme UI'ı (API/WS'i 7717'ye proxy'ler) |
| `20000–20999` | Canlı ortam port havuzu (`AHTAPOT_PORT_FROM` / `AHTAPOT_PORT_TO`) |

**Windows notları**

- Bind-mount yolları kodda `/` ile çevrilir; elle yol yazarken de `E:/x`
  biçimini tercih edin.
- WinNAT bazı port aralıklarını ayırır; port havuzu vermeden önce gerçek bir
  bind dener, ama havuzu ayrılmış bir aralığa denk getirmeyin
  (`netsh int ipv4 show excludedportrange protocol=tcp`).
- Mirror'lara `core.longpaths=true` kendiliğinden yazılır. Hedef repoyu elle
  klonluyorsanız `git config --global core.longpaths true` verin ve kısa bir
  kök seçin (ör. `E:/ws/...`) — derin dosya ağaçlı projeler NTFS'te
  "Filename too long" ile düşer.

---

## Yerel kurulum

```bash
git clone https://github.com/firatoltulu/AhtapotAgentHq.git
cd AhtapotAgentHq
npm install
npm run build
cp .env.example .env          # sonra yolları düzenleyin
```

### 1. Dizinleri ve kimlik dosyasını hazırlayın

```bash
mkdir -p /mutlak/yol/db /mutlak/yol/data
```

Kimlik dosyası (`AHTAPOT_KEYS`) **satır başına bir anahtar** taşır. Boş
satırlar ve `#` ile başlayanlar atlanır. `sk-ant-oat` önekli değer abonelik
token'ı (`CLAUDE_CODE_OAUTH_TOKEN`), diğerleri API anahtarı
(`ANTHROPIC_API_KEY`) olarak verilir. Birden çok satır havuz olur: kotaya
takılan anahtar dinlenmeye alınır, iş sıradakiyle sürer.

```text
# keys.txt
sk-ant-oat01-...
sk-ant-api03-...
```

Abonelik token'ı üretmek için: `claude setup-token`.

> Kimlik dosyası yoksa sunucu `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`
> ortam değişkenlerine düşer. Anahtar dosyası konteynere **asla** mount edilmez;
> her agent çağrısına tek anahtar ayrı verilir.

### 2. `.env`'i doldurun

En az şu üçü — **DB ve DATA ayrı olmalı**:

```dotenv
AHTAPOT_DB=/mutlak/yol/db/ahtapot.sqlite
AHTAPOT_DATA=/mutlak/yol/data
AHTAPOT_KEYS=/mutlak/yol/keys.txt
```

GitHub için yerelde `gh auth login` yeterlidir. Tüm değişkenler:
[Ortam değişkenleri](#ortam-değişkenleri).

### 3. Sunucuyu başlatın

```bash
npm run dev        # derler, sunucuyu dist/'i izleyerek koşar → http://127.0.0.1:7717
```

İlk açılışta:

- Veritabanı migration'ları **kendiliğinden** koşar.
- Agent taban imajı (`ahtapot/agent-base:latest`) arka planda build edilir;
  içerik parmak izi değişmedikçe yeniden build edilmez. Elle build:
  `npm run docker:build`.

Tarayıcıda `http://127.0.0.1:7717` açın. Üst çubukta sunucu bağlantısı,
kimlik havuzu (`kimlik X/Y`) ve `gh token ✓` görünmeli.

---

## Ortam değişkenleri

`.env` dosyası Node'un `--env-file` desteğiyle okunur. Öncelik sırası:
**varsayılan → `AHTAPOT_CONFIG` JSON → ortam değişkeni** (sonraki ezer).
Kaynak: `packages/server/src/config/index.ts`. Ayrıntılı açıklamalar
[`.env.example`](.env.example) içinde.

### Temel

| Değişken | Varsayılan | Ne |
|---|---|---|
| `AHTAPOT_DB` | `./data/ahtapot.sqlite` | SQLite dosyası. **Verin** — verilmezse sunucu sessizce başka DB açar, ekran boş gelir |
| `AHTAPOT_DATA` | `./data` | Mirror, artifact, Analyst'in ürettiği Dockerfile'lar |
| `AHTAPOT_KEYS` | `./data/keys.txt` | Claude kimlik havuzu |
| `AHTAPOT_CONFIG` | — | Aynı ayarları taşıyan düz JSON (`dbPath`, `dataRoot`, `keysFile`, `port`…) |
| `AHTAPOT_HOST` | `127.0.0.1` | Dinlenen adres (compose `0.0.0.0` verir) |
| `AHTAPOT_PORT` | `7717` | Sunucu portu |
| `AHTAPOT_LOG_LEVEL` | `info` | `fatal` … `trace` |
| `AHTAPOT_AGENT_IMAGE` | `ahtapot/agent-base:latest` | Agent taban imajı |
| `AHTAPOT_KEY_COOLDOWN_MINUTES` | `60` | Kotaya takılan anahtarın dinlenme süresi (sıfırlanma zamanı bilinmiyorsa) |

### Güvenlik ve oturum

| Değişken | Varsayılan | Ne |
|---|---|---|
| `AHTAPOT_ADMIN_TOKEN` | — | Girişin birinci faktörü. Sunucu dışarı açıksa **zorunlu sayın** |
| `AHTAPOT_SESSION_HOURS` | `168` | Oturum ömrü (saat) |
| `AHTAPOT_RESET_2FA` | — | `1` ile **bir kez** başlatın → TOTP silinir; sonra kaldırın |

### GitHub ve özel paket kaynakları

| Değişken | Ne |
|---|---|
| `GH_TOKEN` / `GITHUB_TOKEN` | Push, PR, issue, repo listesi. **Docker'da zorunlu** (konteyner host keyring'ini göremez). Yerelde `gh auth token`'a düşer |
| `NPM_TOKEN_*`, `NUGET_TOKEN`, … | Adı profildeki `exec.registries[].tokenEnv` ile **birebir** aynı olmalı. Değer profile yazılmaz |
| `AHTAPOT_REVIEW_KEYS` | Yerel ön inceleme (OCR) anahtarları, satır başına `ad=anahtar`. Claude havuzundan ayrı |

### Bildirimler

| Değişken | Ne |
|---|---|
| `AHTAPOT_VAPID_SUBJECT` | Web Push iletişim adresi (`mailto:…`). Web Push HTTPS ister |
| `AHTAPOT_NTFY_URL` / `AHTAPOT_NTFY_TOKEN` | ntfy kanalı; konu adı tahmin edilemez olmalı |
| `AHTAPOT_PUBLIC_URL` | Bildirim linkleri, issue yorumlarındaki iş linki ve durum rozeti. İnternetten erişilebilir olmalı |

### Canlı ortam, ağ ve Traefik

| Değişken | Varsayılan | Ne |
|---|---|---|
| `AHTAPOT_PORT_FROM` / `AHTAPOT_PORT_TO` | `20000` / `20999` | Canlı ortam port havuzu |
| `AHTAPOT_LIVE_HOST` | `127.0.0.1` | Canlı portların yayınlandığı host adresi. Uzak sunucuda LAN IP'si verin |
| `AHTAPOT_LIVE_NETWORK` | — (compose: `ahtapot`) | Sunucu **konteynerde** koşuyorsa gerekli; host'ta koşuyorsa boş bırakın |
| `AHTAPOT_BRIDGE_HOST` | `host.docker.internal` | Konteynerlerin sunucunun `/bridge` ucuna ulaştığı ad |
| `AHTAPOT_WORKSPACES_ROOT` | — | "Klonla" / "GitHub'dan seç" modlarında hedef yol `<kök>/<repo>` olarak türetilir |
| `AHTAPOT_TRAEFIK_DYNAMIC_DIR` | — | Traefik file-provider dizini. Boşsa canlı ortam yalnız `127.0.0.1` |
| `AHTAPOT_TRAEFIK_BACKEND_HOST` | `127.0.0.1` | Traefik'in sunucuya ulaştığı adres |
| `AHTAPOT_WEB_DIST` | `packages/web/dist` | Servis edilen UI dizini |

---

## Proje bağlama (akış)

Hedef proje sistemin parçası **değildir**; dışarıdan bağlanır. Bağlama bir kez
yapılır, sonra o projeye istediğiniz kadar iş girersiniz. UI tarafı
[kullanım kılavuzunda](docs/kullanim-kilavuzu.md#2-proje-bağlama) adım adım;
burada akış ve ilgili uçlar:

```
1. Workspace ekle ──► 2. Analyst taraması ──► 3. Taslak profil
                                                   │  incele / düzenle / doğrula
                                                   ▼
        5. İş girilebilir ◄── 4. Proje imajı build ◄── Profil onayı
```

| Adım | UI | REST |
|---|---|---|
| **1. Workspace ekle** | Projeler → "Workspace bağla": *Mevcut yol*, *Klonla (URL)* ya da *GitHub'dan seç* | `POST /api/projects` `{slug, name, workspaceRoot?, gitUrl?}` |
| Klon başarısızsa | Proje kartında "yeniden dene" | `POST /api/projects/:id/retry-clone` |
| **2. Analyst** | "Bağla ve analiz et" ya da proje sayfasında "Analiz et" | `POST /api/projects/:id/analyze` → `GET /api/analyses/:id` |
| **3. Profil** | Profil sürümleri, editör, "Doğrula" | `GET/POST /api/projects/:id/profiles`, `POST /api/profiles/:id/validate` |
| **Profil onayı** | "Onayla" / "Reddet" | `POST /api/profiles/:id/decision` `{decision, comment}` |
| **4. Proje imajı** | Onayla birlikte kendiliğinden; karttan "Yeniden build et" | `POST /api/profiles/:id/build-image`, `GET /api/image-builds/:id/log` |
| Kod haritası (isteğe bağlı) | "Kod haritası" kartı → "Haritayı üret" | `GET/POST /api/projects/:id/codemap` |

**Kurallar**

- **Taslak profille iş koşmaz.** `activeProfile()` yalnız onaylı profili döndürür.
- Proje imajı (`ahtapot/<slug>`) motor reposunda **yaşamaz**: Analyst tarifi
  `AHTAPOT_DATA/artifacts` altına üretir, profil `exec.dockerfile` ile gösterir.
  Taban imaj değişince proje imajı ilk işten önce yeniden build edilir.
- Hedef proje kendi çalışma disiplinini (safha onayı, commit politikası,
  build adımları, review süreci) **profil alanlarıyla** getirir. Projeye özgü
  bir davranışı motora gömmeyin; `ProjectProfileSchema`ya alan ekleyin.

### Profilin ana bölümleri

`packages/shared/src/profile.ts` → `ProjectProfileSchema`

| Bölüm | Ne belirler |
|---|---|
| `workspace` | Kök, alt repolar, `ignoredButNeeded`, emsal repolar |
| `exec` | İmaj, Dockerfile, kaynak sınırları, cache'ler, `registries`, egress izinleri |
| `build` | `preSteps`, `steps` (en az bir), yasak bayraklar, ne zaman build edilir |
| `services` / `database` | Bağımlı servisler; DB türü, migrate, seed, klon |
| `live` | Canlı ortam: compose, sağlık kontrolü, erişim (`direct`/`proxy`/`tunnel`), `ttlMinutes` |
| `test` | Test komutları, `caseApproval` |
| `git` | Dal deseni, commit şablonu, PR (`draft`, `base`, `openApproval`, `mergeApproval`, `mergeMethod`) |
| `tracker` | GitHub issue eşlemesi ve etiketle karar |
| `release` | Release kartının tetikleyeceği workflow |
| `workflow` | `developing` (`phased`/`single`), commit politikası, review (CodeRabbit, yerel OCR, SAST) |
| `agents` | Roller, triage, mentor, kod haritası |
| `security` | Hassas dosyalar, `neverCopy`, yasak araç/bash desenleri, `askTimeoutMinutes` |
| `limits` | Bütçe ve tur sınırları |

### GitHub bağlantısı

PR açma, CI izleme, issue eşlemesi ve "GitHub'dan seç" için `gh` kimliği
gerekir: yerelde `gh auth login`, Docker'da `GH_TOKEN`. Profilde
`git.pr.provider: github` olmalı. GitHub issue'larından iş üretmek ve
etiketle (`ahtapot-test: onay` / `ahtapot-test: düzelt`) canlı testi
kararlaştırmak için `tracker` bölümünü açın; issue yorumlarında link ve rozet
için `AHTAPOT_PUBLIC_URL` tanımlayın.

---

## Sunucuya kurulum (Docker)

Sunucu imajı: `ghcr.io/firatoltulu/ahtapot-server`. Yayın **elle**
tetiklenir (`release` workflow'u, `workflow_dispatch`): sürümü conventional
commit'lerden hesaplar, imajı yayınlar, ardından tag ve GitHub Release açar.
Elle atılan bir `v*` tag'i tek başına hiçbir şey yayınlamaz. Otomatik deploy
yoktur.

```bash
cp .env.example .env    # sunucu değerleriyle doldurun
docker compose pull
docker compose up -d
```

Güncelleme: `docker compose pull && docker compose up -d`.

**Bilinmesi gerekenler**

- **Docker-in-Docker yok.** Host'un `docker.sock`'u paylaşılır; agent ve canlı
  ortam konteynerleri host'ta, sunucunun yanında açılır. Bu yüzden DATA, DB,
  KEYS ve workspace yolları konteynere **host'taki aynı mutlak yolla**
  bağlanır. Compose şu host değişkenlerini ister:

  | Değişken | Ne |
  |---|---|
  | `AHTAPOT_DATA_HOST` | `AHTAPOT_DATA`'nın host yolu |
  | `AHTAPOT_DB_HOST_DIR` | SQLite dosyasının bulunduğu host dizini |
  | `AHTAPOT_KEYS_HOST` | Kimlik dosyası (salt okunur bağlanır) |
  | `AHTAPOT_WORKSPACES_ROOT_HOST` | Workspace kökü |

- `GH_TOKEN` ve `AHTAPOT_ADMIN_TOKEN`'ı tanımlayın. `AHTAPOT_LIVE_NETWORK`
  compose ağıyla (`ahtapot`) aynı olmalı.
- Traefik ayrı makinede koşar ve bu host'un `7717`'sine bağlanır. Firewall'da
  `7717`'yi yalnız Traefik'in IP'sine açın. Canlı ortamları Traefik'ten
  yayınlamak için `AHTAPOT_TRAEFIK_DYNAMIC_DIR` (NFS'te `root_squash` açıksa
  `nobody`'ye yazma izni verin).
- Canlı ortam güvenilmeyen kod koşturur: `AHTAPOT_LIVE_HOST`'u yalnız güvenli
  ağda dış arayüze açın.

---

## Geliştirme

```bash
npm run dev                             # derle + sunucuyu izleyerek koş (7717)
npm run dev:build -w @ahtapot/server    # ayrı terminal: kaynağı izleyip derle
npm run dev -w @ahtapot/web             # UI geliştirme (5180, API/WS proxy)
npx tsc -b                              # tip kontrolü
npm run build                           # tüm paketler
npm test -w @ahtapot/shared             # testler (node:test)
npm test -w @ahtapot/server
npm run db:generate                     # şema değişince migration üret
```

`dev` betiği `dist/`i izler, kaynağı değil: NodeNext gereği importlar `.js`
uzantılıdır ve kaynaktan doğrudan koşulamaz. Kaynağı değiştirince
`dev:build`in derlemesini bekleyin.

Kod tarzı, veritabanı taşınabilirlik kuralları ve değişmez kurallar
(durum yalnız `engine/transition.ts` üzerinden değişir, sır maskeleme,
kimlik izolasyonu…) için [`CLAUDE.md`](CLAUDE.md). Bir davranış eklerken
sorulacak soru: *bu her proje için doğru mu, yoksa bu projenin tercihi mi?*
İkincisiyse profile alan ekleyin.

---

## Sorun giderme

| Belirti | Neden / çözüm |
|---|---|
| Ekran boş, işler görünmüyor | `AHTAPOT_DB` verilmemiş; sunucu `./data/ahtapot.sqlite` açmış |
| Docker'da push/PR/issue kimliksiz düşüyor, `could not read Username` | `GH_TOKEN` yok — konteyner host keyring'ini göremez |
| Canlı ortam sağlık kontrolü zaman aşımına uğruyor (sunucu konteynerde) | `AHTAPOT_LIVE_NETWORK` boş ya da compose ağ adıyla aynı değil |
| Başka makineden canlı porta "Couldn't connect" | `AHTAPOT_LIVE_HOST` hâlâ `127.0.0.1` |
| `EACCES: mkdir` (Traefik dizini) | Dizin konteynere aynı yolla bağlanmamış ya da NFS izni eksik |
| Klon "Permission denied", dosyalar host'a düşmüyor | `AHTAPOT_WORKSPACES_ROOT_HOST` mount'u eksik |
| `image not found` | Proje imajı build edilmemiş — proje sayfasındaki imaj kartından "Yeniden build et" |
| API `400 … version … or newer` | Taban imaj eski; sunucuyu yeniden başlatın ya da `npm run docker:build` |
| Her açılışta ikinci faktör siliniyor | `AHTAPOT_RESET_2FA=1` kalıcı bırakılmış |
| Uyarı: canlı uygulama API'ye kimliksiz erişebilir | `AHTAPOT_LIVE_NETWORK` var ama `AHTAPOT_ADMIN_TOKEN` yok |
| Windows'ta "Filename too long" | `core.longpaths true` + kısa workspace kökü |

---

## Mimari ve belgeler

![AhtapotAgent mimarisi](docs/diagrams/architecture.svg)

Sunucu tek durum otoritesidir: agent'lar Docker sandbox'ında koşar ve sunucuya
`/bridge` WebSocket'iyle bağlanır, her iş kendi worktree volume'ünü ve canlı
ortamını alır. İnsan canlı ortamı doğrudan porttan test eder.

![Bir işin yolculuğu](docs/diagrams/agent-flow.svg)

Kesikli ok dört kaynaktan gelir: kırmızı build, canlı test kusuru, QA hatası ya
da PR reddi işi Developer'a döndürür. Agent koşarken insan her adımda onunla
konuşabilir. Diyagramların kaynakları `docs/diagrams/*.html`.

```
packages/shared   Zod şemaları — DB, REST, WS ve agent çıktısı tek kaynaktan
packages/server   Fastify + WebSocket + Drizzle + Agent SDK sürücüsü (modüler monolit)
packages/web      React UI (Vite + Tailwind + TanStack Query)
packages/bridge   Konteyner içi WS köprüsü
agents/core       Proje-agnostik rol promptları (analyst, planner, developer, qa, devops, …)
docker/           Agent taban imajı ve sunucu imajı
```

Güvenlik sınırı: agent'ın yan etkileri konteynerde ve worktree'de kalır.
Kimlik her çağrıya ayrı verilir, konteyner daima tek anahtar görür. DB'ye ya da
WebSocket'e giden her metin sır maskelemesinden geçer.

| Dosya | Ne |
|---|---|
| [`docs/kullanim-kilavuzu.md`](docs/kullanim-kilavuzu.md) | Kullanım kılavuzu |
| [`CLAUDE.md`](CLAUDE.md) | Çalışma kuralları |
| [`docs/plan/00-master-plan.md`](docs/plan/00-master-plan.md) | Onaylı ana plan: mimari, durum makinesi, fazlar |
| [`docs/plan/01-decisions.md`](docs/plan/01-decisions.md) | Kararlar ve gerekçeleri |
| [`docs/plan/02-status.md`](docs/plan/02-status.md) | Ne bitti, ne sırada |

---

## Yol haritası

Bugün sistem tek yöneticili: giriş tek bir `AHTAPOT_ADMIN_TOKEN` ve sistem
geneli bir TOTP ile korunuyor, veri SQLite'ta. Sıradaki kilometre taşları:

- [ ] **Çoklu kullanıcı** — her kişinin kendi hesabı ve oturumu; işler,
      onaylar ve sohbetler kimin yaptığıyla kaydedilir.
- [ ] **Kullanıcı ve takım bazlı workspace** — projeler bir kullanıcıya ya da
      takıma ait olur; erişim ve onay yetkisi buna göre ayrılır.
- [ ] **PostgreSQL desteği** — şema baştan taşınabilir kurallarla yazıldı
      (UUIDv7 TEXT PK, ISO-8601 zaman, enum yok); SQLite yanında PostgreSQL
      sürücüsü.
- [ ] **Kullanıcı bazlı 2FA** — ikinci faktörü her kullanıcı kendi hesabında
      açar, kapatır ve sıfırlar; sistem geneli `AHTAPOT_RESET_2FA` yerine.
- [ ] **UI/UX iyileştirmeleri** — daha sade ve tutarlı bir arayüz, daha iyi
      akış görünürlüğü.
