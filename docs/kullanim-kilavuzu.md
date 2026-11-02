# Kullanım kılavuzu

Bu kılavuz AhtapotAgent'ı **UI'dan kullanan** kişi içindir: proje bağlamak,
iş girmek, agent'larla konuşmak ve onay kapılarında karar vermek. Kurulum ve
ortam değişkenleri için [README](../README.md).

---

## İçindekiler

1. [Giriş ve ekran düzeni](#1-giriş-ve-ekran-düzeni)
2. [Proje bağlama](#2-proje-bağlama)
3. [İş girme](#3-iş-girme)
4. [İşin yaşam döngüsü](#4-işin-yaşam-döngüsü)
5. [Onay kapıları](#5-onay-kapıları)
6. [Koşan agent'la konuşmak](#6-koşan-agentla-konuşmak)
7. [Canlı ortam](#7-canlı-ortam)
8. [Takılan, iptal edilen, yeniden açılan işler](#8-takılan-iptal-edilen-yeniden-açılan-işler)
9. [Bildirimler ve güvenlik](#9-bildirimler-ve-güvenlik)
10. [Sık sorulanlar](#10-sık-sorulanlar)

---

## 1. Giriş ve ekran düzeni

Tarayıcıda sunucunun adresini açın (yerelde `http://127.0.0.1:7717`).

**Giriş.** Sunucuda yönetici token'ı tanımlıysa önce o sorulur; iki adımlı
doğrulama bağlıysa ardından 6 haneli TOTP kodu istenir.

**Üst çubuk** her sayfada şunları gösterir:

| Gösterge | Anlamı |
|---|---|
| Bağlantı | Sunucuya WebSocket bağlantısı. Kopukken akış güncellenmez |
| `kimlik X/Y` | Kullanılabilir Claude kimliği / toplam. Kotaya takılan anahtar bir süre dinlenir |
| Koşan iş sayısı | Şu an agent'ı çalışan işler |
| `gh token ✓` / `yok` | Sunucunun GitHub kimliği. Yoksa PR, push ve issue işlemleri yapılamaz |
| "Güvenlik ve bildirimler" | İki adımlı doğrulama, telefon bildirimleri, çıkış |

**Sayfalar**

| Sayfa | Ne var |
|---|---|
| **Projeler** (`/`) | Sizi bekleyen işler, koşan işler, bağlı projeler, "Workspace bağla" formu |
| **Proje detayı** | Workspace durumu, analizler, profil sürümleri ve editörü, imaj build'i, kod haritası, issue şablonları, release kartı |
| **İşler** (`/jobs`) | Projeye ve duruma göre filtrelenen işler, GitHub issue'ları, "Yeni iş" paneli |
| **İş detayı** | Akış, plan, değişiklikler, build logu, onay panelleri, canlı ortam kartı, sohbet |

---

## 2. Proje bağlama

Her proje bir kez bağlanır. Bağlama tamamlanmadan (profil onaylanmadan) o
projeye iş girilemez.

### 2.1 Workspace bağla

Projeler sayfasında **"Workspace bağla"** formunu açın ve üç moddan birini
seçin:

| Mod | Ne zaman |
|---|---|
| **Mevcut yol** | Repo sunucunun diskinde zaten var. Mutlak yolu girin |
| **Klonla (URL)** | Git URL'si verin; sunucu klonlar. Yol, sunucuda workspace kökü tanımlıysa kendiliğinden türetilir |
| **GitHub'dan seç** | Sunucunun GitHub kimliğinin eriştiği repolar listelenir; birini seçin |

Kısa ad (`slug`) ve görünen adı yazın, **"Bağla ve analiz et"** deyin. Klon
sürerken kart "bekliyor" görünür; düşerse karttan yeniden deneyin.

### 2.2 Analyst analizi

Analyst repoyu tarar: dil ve araç zinciri, build sırası, test komutları,
servisler, veritabanı, git düzeni, hassas dosyalar. Sonuç bir **taslak
profildir**. Analiz bitince bildirim gelir. Repoda büyük değişiklik olduysa
proje sayfasından **"Analiz et"** ile yeniden koşturabilirsiniz.

### 2.3 Profili incele ve onayla

Profil, motorun bu projede **nasıl** çalışacağını söyler. Onaylamadan önce
özellikle şunlara bakın:

- **Build adımları ve sırası** — yanlış sıra sessizce bozuk çıktı üretebilir.
- **Yasak bayraklar** — projede kullanılmaması gereken derleme seçenekleri.
- **Hassas dosyalar / `neverCopy`** — token, sertifika, `.env` gibi dosyalar
  agent'a kopyalanmamalı.
- **Geliştirme biçimi** — `phased` (safhalı, her safhada onay) ya da `single`.
- **PR ayarları** — draft mı, hangi dala, açılış ve merge onayı istensin mi.
- **Canlı ortam** — açık mı, hangi servisler, sağlık kontrolü.

Editörde düzenleyip kaydedin, **"Doğrula"** ile mekanik kontrol koşturun
(doğrulama onayı engellemez, uyarır). Sonra **"Onayla"** ya da yorumla
**"Reddet"**.

### 2.4 Proje imajı

Onayla birlikte proje imajı (`ahtapot/<slug>`) arka planda build edilir.
Proje sayfasındaki imaj kartı durumunu ve logunu gösterir. "İmaj build'i
düştü" görürseniz logu okuyun, gerekirse profilde `exec` bölümünü düzeltip
**"Yeniden build et"** deyin. İmaj hazır olmadan Developer başlayamaz.

### 2.5 Kod haritası (isteğe bağlı)

"Kod haritası" kartından **"Haritayı üret"**: projenin modül/dosya haritası
çıkarılır ve agent'lara salt okunur verilir. Büyük repolarda agent'ın doğru
yere daha hızlı gitmesini sağlar.

---

## 3. İş girme

İşler sayfasında **"Yeni iş"**:

| Alan | Not |
|---|---|
| **Proje** | Profili onaylı projeler listelenir |
| **Başlık** | Kısa ve net |
| **Açıklama** | Ne isteniyor, kabul ölçütü, kısıtlar. Ne kadar açık o kadar iyi plan |
| **Hedef repolar** | Boş bırakılabilir; Planner seçer, plan onayında düzeltirsiniz |
| **Emsal yollar** | "Şuradaki plugin'lere bak" türü örnek dizinler (sunucudaki mutlak yol, en çok 10). Agent'a salt okunur verilir |
| **Ekler** | Ekran görüntüsü, belge |
| **Öncelik** | −10 … 10 |

GitHub issue eşlemesi açık projelerde İşler sayfası issue'ları da listeler;
bir issue'dan iş üretilebilir. İş, issue'ya bağlantılı kalır ve durumu
issue'ya yorum olarak yansır.

---

## 4. İşin yaşam döngüsü

```
Draft → Planning → PlanReview → Developing → Building → LiveTest
      → QACases → QA → PRReview → CIWatch → Done
```

Her durumdan `NeedsAttention`'a (takıldı) düşülebilir; bitmemiş her iş iptal
edilebilir ([§8](#8-takılan-iptal-edilen-yeniden-açılan-işler)).
Building, LiveTest, QACases, QA ve PRReview'dan **Developing'e geri dönüş**
vardır: build kırıldığında, canlı testte hata bulduğunuzda ya da review
düzeltme istediğinde iş Developer'a geri gider.

| Durum | Kim çalışıyor | Siz ne yapıyorsunuz |
|---|---|---|
| **Planning** | Planner (önce triage model seviyesini seçer) | İsterseniz sohbetten yön verin |
| **PlanReview** | — | Planı okuyun, soruları cevaplayın, onaylayın ya da itiraz edin |
| **Developing** | Developer | Akışı izleyin; safhalıysa her safha sonunda onay |
| **Building** | Motor | Kırılırsa log "Build logu" sekmesinde; iş Developer'a geri döner |
| **LiveTest** | Canlı ortam | Uygulamayı kendi tarayıcınızdan test edin, karar verin |
| **QACases** | QA | Test case listesini düzenleyin ve onaylayın |
| **QA** | QA / Tester | Testler yazılır ve koşulur |
| **PRReview** | DevOps | PR açılışını onaylayın; review turları burada döner |
| **CIWatch** | DevOps | CI izlenir; kırılırsa düzeltme turu açılır |
| **Done** | — | Gerekirse yeniden açın |

### İş detayı sekmeleri

| Sekme | Ne |
|---|---|
| **İşin detayları** | Açıklama, hedef repolar, ekler, bağlı issue |
| **Akış** | Agent mesajları, araç çağrıları, durum geçişleri — canlı |
| **Değişiklikler** | Worktree'deki diff, dosya listesi |
| **Plan** | Onaylanan/bekleyen plan, safhalar, plan dışı dosya uyarıları |
| **Build logu** | Son build'in tam çıktısı |

Sol listede işler **sizi bekleyen / koşan / biten** diye gruplanır. "Sizi
bekleyen" grubundaki her iş bir kararınızı bekliyordur.

---

## 5. Onay kapıları

Kapı açıldığında iş detayında bir panel belirir ve bildirim gelir. Kararınıza
yorum ekleyebilirsiniz; reddederken yorum **zorunlu kabul edin** — agent
neyi düzelteceğini oradan öğrenir.

| Kapı | Ne zaman | Seçenekler |
|---|---|---|
| **Profil** | Analyst taslak profil ürettiğinde | Onayla / Reddet |
| **Plan** | Planner planı yazdığında | "Planı onayla" / "Reddet ve geri gönder". Plan açık soru taşıyorsa "Planner soruları" bölümünden cevaplayın — cevap red değildir, plan güncellenir |
| **Safha** | Safhalı geliştirmede her safha sonu | "Onayla ve sonraki safhaya geç"; sonraki safhanın model seviyesini seçebilirsiniz |
| **Canlı test** | Build geçip canlı ortam ayağa kalkınca | "Test geçti, onayla" → QA'ya geçer. Yorumla reddedin → "Canlı test düzeltmesi" safhası açılır |
| **QA case listesi** | QA test senaryolarını çıkarınca | Listeyi düzenleyin, "Listeyi onayla". Profilde `caseApproval: false` ise kendiliğinden geçer |
| **PR açılışı** | PR açılmadan önce (profilde açıksa) | Onayla / Reddet |
| **Merge** | Merge öncesi (profilde açıksa) | "Merge et ve temizle" |
| **Takıldı / review turu / güvenlik** | Agent ilerleyemediğinde, review ya da güvenlik taraması bulgu ürettiğinde | Onay → düzeltebilecek role geri gönder ya da bir tur daha; red → olduğu gibi devam |

**GitHub etiketiyle karar.** Issue eşlemesi açık projelerde canlı test
kararını issue'ya `ahtapot-test: onay` ya da `ahtapot-test: düzelt` etiketi
koyarak da verebilirsiniz (birkaç saniye içinde algılanır). Test eden kişinin
UI'a girmesi gerekmez.

---

## 6. Koşan agent'la konuşmak

Sistemin farkı budur: agent çalışırken iş detayındaki sohbet kutusuna
(**"Agent'a yaz…"**) yazabilirsiniz.

- **Normal gönderim** — mesaj agent'ın mevcut turu bittiğinde ona iletilir.
  Yön vermek, ek bilgi vermek, "şu dosyaya dokunma" demek için.
- **"Mevcut turu kes, mesajı hemen işlet"** — agent yanlış yöne gidiyorsa
  turu keser ve mesajınızı hemen işletir.

**Agent'ın soruları.** Agent emin olmadığı bir noktada size soru sorabilir
(`ask_user`). Soru iş detayında ve bildirimde görünür; **"Cevapla →"** ile
yanıtlayın. Belirli süre (profilde `askTimeoutMinutes`, varsayılan 30 dk)
cevap gelmezse agent bir varsayımla devam eder ve bunu akışa yazar.

---

## 7. Canlı ortam

LiveTest durumunda iş, değişikliklerinizle çalışan uygulamayı kendi
konteynerinde ayağa kaldırır.

- **"Canlı ortamı aç ↗"** uygulamayı yeni sekmede açar (port havuzundan bir
  port ya da Traefik üzerinden bir adres).
- Ortamın ömrü sınırlıdır (varsayılan 120 dk). Karttan **uzatın**; işiniz
  bittiyse durdurun.
- Ortam bozulduysa **"Ortamı yeniden kaldır"**. Ortam değişkenlerini
  düzenleyip **"Kaydet ve yeniden kaldır"** da diyebilirsiniz.
- Hata bulduysanız canlı test kapısında **ne gördüğünüzü, nerede ve nasıl
  tekrarlanacağını** yazarak reddedin. İş Developer'a döner, düzeltilince
  ortam yeniden kalkar.

> Canlı ortam agent'ın yazdığı kodu koşturur. Gerçek müşteri verisi ya da
> üretim kimlik bilgisi girmeyin.

---

## 8. Takılan, iptal edilen, yeniden açılan işler

| Durum | Ne yapmalı |
|---|---|
| **NeedsAttention** | İş takıldı ya da sunucu yeniden başlarken yarıda kaldı. Akışın sonunu okuyun; **"Yeniden dene"** ya da farklı bir modelle **"Modelle yeniden dene"** |
| **Build kırıldı** (tekrar tekrar) | Build logunu okuyun; ortamsal bir sorunsa (eksik token, imaj) önce onu çözün, sonra yeniden deneyin |
| **İptal** | İş detayından iptal edin. İptal işi **siler**: koşan tur kesilir, iş kayıtları, worktree'si ve canlı ortamı kaldırılır; geri alınamaz. Biten (`Done`) iş iptal edilemez — yeniden açın |
| **Done ama eksik** | **"İşi yeniden aç"** — hangi aşamaya döneceğini seçin (Planning, Developing, LiveTest, QA, PRReview…) |
| **Kimlik kalmadı** (`kimlik 0/Y`) | Tüm anahtarlar kotada; dinlenme süresi dolunca iş kendiliğinden sürer. Acilse sunucuya yeni anahtar eklensin |

---

## 9. Bildirimler ve güvenlik

**"Güvenlik ve bildirimler"** penceresinden:

- **İki adımlı doğrulama** — QR kodu authenticator uygulamasıyla okutun,
  kodu girip bağlayın. Telefonu kaybederseniz sunucu yöneticisi 2FA'yı
  sıfırlayabilir.
- **Telefon bildirimleri** — cihaz başına açılır. Onay kapısı, agent sorusu,
  takılan iş ve taslak profil için bildirim gelir. Web Push **HTTPS ister**;
  iPhone'da yalnız Safari'den **"Ana Ekrana Ekle"** ile kurulmuş uygulamada
  çalışır. Test bildirimi göndererek deneyin.
- HTTPS yoksa sunucuda ntfy kanalı tanımlanabilir: telefondaki ntfy
  uygulamasıyla aynı konuya abone olursunuz.

---

## 10. Sık sorulanlar

**Ekran boş, hiç proje/iş görünmüyor.**
Büyük olasılıkla sunucu yanlış veritabanını açtı. Yöneticiye `AHTAPOT_DB`
ayarını kontrol ettirin.

**"Yeni iş" panelinde projem yok.**
Profili onaylı değil. Proje sayfasından taslak profili onaylayın.

**PR açılmıyor, push düşüyor.**
Üst çubukta `gh token yok` görünüyorsa sunucunun GitHub kimliği eksik.

**Canlı ortam linki başka bilgisayardan açılmıyor.**
Sunucu canlı portları yalnız kendi makinesine açıyor olabilir; yöneticiden
canlı ortam host adresini (ya da Traefik'i) ayarlamasını isteyin.

**Agent planda olmayan dosyalara dokunuyor.**
Safha onayında "plan dışı dosya" uyarısı görünür. Reddedip gerekçe yazın ya da
sohbetten "yalnız plandaki dosyalar" deyin.

**Agent yanlış yolda ama turunu bitirmesini beklemek istemiyorum.**
Sohbette "Mevcut turu kes, mesajı hemen işlet" seçeneğini kullanın.
