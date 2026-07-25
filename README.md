# qneed — AI İkiz (Faz 2: Instagram DM)

Kişilik klonu satış AI'ı. **Beyin** hazır (senin tarzınla konuşup satış yapmaya çalışan
sohbet motoru + geçmiş konuşmalarını biriktiren Supabase deposu) ve artık **Instagram
DM'lerine canlı cevap verebiliyor** (`npm run instagram` — aşağıda kurulum var).
WhatsApp aynı adaptör deseniyle eklenecek.

**Tarz nereden öğreniliyor?** Elle yazılmış bir "persona" yok. İkizin tarzı %100 senin
kaydettiğin gerçek konuşmalardan öğreniliyor. Her müşteri mesajında sistem, arşivindeki
konuşmaları **anlamsal olarak arayıp** (RAG) o duruma en uygun olanları sistem promptuna
koyuyor — yani "melazma" sorusuna melazma konuşmaların, "fiyat" sorusuna fiyat konuşmaların
örnek olarak gidiyor. Claude bunları kopyalamaz; tarzı harmanlayıp yeni cümle üretir.

## Ne var
- **Arayüz** (`npm run ui`): tarayıcıda açılan 3 sekmeli kontrol panosu — Veri Girişi / Test Simülasyonu / Sistem Promptu.
- **Supabase**: `conversations` (geçmiş satış diyalogların + anlam parmak izi/embedding), `messages`, `products` (katalog), `chat_logs` (ikizin kendi görüşmeleri).
- **Beyin**: nötr rol + satış oyun kitabı + güvenlik kuralları + katalog + **duruma göre seçilen gerçek konuşma örnekleri**nden sistem promptu kurar; Claude ile sohbet eder.
- **RAG / embedding**: konuşmalar [Voyage AI](https://voyageai.com) ile "anlam parmak izi"ne çevrilip Supabase pgvector'de aranır. Sağlayıcı `src/embed.ts` arkasında soyut.
- **Ingest** (`npm run ingest`): `data/` altındaki `.md` dosyalarını toplu olarak Supabase'e yükler.
- **Embed** (`npm run embed`): mevcut konuşmaların parmak izini toplu üretir/tazeler (geriye dönük doldurma; yeni konuşmalar zaten otomatik gömülür).
- **Instagram DM** (`npm run instagram`): gerçek DM'leri alır, ikiz cevaplar; sen telefondan yazınca ikiz susar.
- **Yorum tetikleyicileri**: gönderi altına "fiyat" gibi belirlediğin kelimeyi yazana otomatik DM (kurulum ve kurallar aşağıda).
- **Telegram kumandası**: müşteri mesajları Telegram'a düşer; `/pause` - `/resume` ile ikizi yönetirsin, fotoğraf gelince ikiz kendini durdurur.

## Kurulum

1) Bağımlılıklar (bir kez):
```
npm install
```

2) Ortam değişkenleri: `.env.example` dosyasını `.env` olarak kopyala, doldur.
   - `ANTHROPIC_API_KEY` → https://console.anthropic.com > API Keys
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` → Supabase panelinde Project Settings > Data API / API Keys
     (service_role anahtarı gizli; sadece bu sunucu tarafı projede kullan).
   - `VOYAGE_API_KEY` → https://dashboard.voyageai.com > API Keys (RAG embedding için).
     Yoksa sistem yine çalışır ama örnekleri anlamsal arama yerine kaliteye göre seçer.

3) Supabase şeması: Supabase panelinde SQL Editor'e `supabase/schema.sql` içeriğini yapıştır ve
   çalıştır. (Dosyanın sonundaki RAG bloğu pgvector eklentisi + `embedding` sütunu +
   `match_conversations` arama fonksiyonunu kurar; tekrar çalıştırması güvenlidir.)

4) Mevcut konuşmaları gömle (Voyage anahtarı eklendikten sonra, bir kez):
```
npm run embed
```

## Kullanım — Arayüz (önerilen)

```
npm run ui
```
Tarayıcıda `http://localhost:3939` açılır. Sekmeler:
1. **Veri Girişi** — konuşma ve ürün ekle/düzenle/sil (doğrudan Supabase'e yazar).
   Konuşmada "Örnek olarak kullan" işaretlersen ikiz o tarzı taklit eder.
2. **Test Simülasyonu** — müşteri gibi yaz, ikiz cevaplasın. Her mesajda o mesaja en uygun
   konuşmalar anlamsal aramayla seçilip sistem promptu yeniden kurulur; yeni eklediğin veri
   anında etkiler.
3. **Sistem Promptu** — ana talimatları (rol + oyun kitabı + kurallar) düzenle-kaydet, kurulan
   tam promptu gör.
4. **Instagram** — tetikleyici kelimeler (yorum/DM), gelen yorumlar, canlı sohbetler ve
   hangi müşteride ikizin açık olduğu. Ayrıntı aşağıda.

## Kullanım — Terminal / toplu

**İkizle terminalde sohbet:** `npm run chat` (çıkmak için `çık`)

**Dosyadan toplu yükleme:** `data/conversations/*.md` ve `data/products/*.md` dosyalarını
(`ornek-01.md` / `denge-serumu.md` formatında) koyup:
```
npm run ingest
```
(Aynı dosyayı tekrar yüklersen günceller — dosya adı = slug.)

> Not: Supabase bağlı değilken de sohbet/arayüz açılır (sadece katalog/örnek olmadan,
> `data/persona.md` ile). Tam güç için Supabase'i doldur.

## Örnek seçimi nasıl çalışıyor? (RAG)
Her müşteri mesajında prompta en fazla 8 konuşma girer. Öncelik sırası (`src/brain.ts`):
1. **"Örnek" işaretli** (is_exemplar) konuşmalar — her zaman girer (elle kürasyon).
2. Gelen mesaja **anlamca en yakın** konuşmalar (Voyage embedding + pgvector; benzerlik eşiği 0.30).
3. Boşluk kalırsa **kaliteye göre** yedek (önizlemede, anahtar yokken ya da yeni kurulumda).

> Faydası ~20-30+ konuşmada belirginleşir; az veride zaten hepsi geliyor.

## Instagram DM entegrasyonu (Faz 2)

İkiz artık gerçek Instagram DM'lerine cevap verebiliyor: `npm run instagram`.
Beyin aynı beyin — sadece bir **kanal adaptörü** eklendi (`src/instagram.ts`,
`src/webhook.ts`). Aynı mantıkla WhatsApp da eklenecek.

### Nasıl çalışıyor
1. Müşteri DM atar → Meta senin webhook adresine POST eder.
2. Sunucu imzayı doğrular, mesajı `ig_messages`'a yazar (aynı mesaj iki kez gelirse eler).
3. **İkiz hemen cevap yazmaz, susmasını bekler** (aşağıdaki "Mesaj biriktirme").
4. Sohbet geçmişi + RAG ile seçilen örnek konuşmalar → Claude → tek cevap.
5. "Yazıyor..." göstergesi + cevap uzunluğuna göre kısa bir bekleme, sonra gönderim.
   Boş satırla ayrılmış paragraflar **ayrı mesaj** olarak gider.
6. Her şey **Telegram'a** düşer; oradan `/pause` - `/resume` ile yönetirsin.

Müşteri **fotoğraf** gönderirse ikiz durur ve fotoğrafı Telegram'a iletir (aşağıda).
Fotoğrafı arşivlemiyoruz — Meta'nın linki 24 saat sonra ölüyor, biz sadece o an okuyoruz.

### Mesaj biriktirme (neden hemen cevap vermiyor)
İnsanlar tek mesaj yazmaz; alt alta 4-5 mesaj atarlar. Her birine ayrı cevap yazmak
robot işi. Bu yüzden ikiz:
- son mesajdan sonra **45-90 saniye** (rastgele) susmasını bekler,
- bu sürede yeni mesaj gelirse süre **baştan başlar**,
- müşteri hiç susmazsa ilk mesajdan **5 dakika** sonra eldekiyle cevap verir (tavan),
- sonunda o ana kadarki tüm mesajları birden okuyup **tek** cevap yazar.

Süreler `.env`'den ayarlanır (`IG_WAIT_MIN_SEC`, `IG_WAIT_MAX_SEC`, `IG_WAIT_CEILING_SEC`,
`IG_TYPING_MIN_SEC`, `IG_TYPING_MAX_SEC`).

## Telegram kumandası

Instagram'ı takip etmek için telefonu elde tutmana gerek yok: her şey Telegram'a düşer,
ikizi oradan durdurup başlatırsın. **Tünel gerekmiyor** — bot dışarı doğru bağlanıyor.

**Kurulum:** Telegram'da `@BotFather` → `/newbot` → aldığın token'ı `.env`'e
`TELEGRAM_BOT_TOKEN=` olarak yaz. `TELEGRAM_CHAT_ID`'yi bilmiyorsan boş bırak:
`npm run instagram` çalışırken botuna bir mesaj at, konsol chat id'yi yazacak,
onu `.env`'e ekleyip yeniden başlat. (Bu alan güvenlik için: sadece senin
hesabın komut verebilsin diye.)

**Ne düşer:** gelen müşteri mesajları, ikizin verdiği cevaplar, fotoğraflar.

**Komutlar:**

| Komut | Ne yapar |
|---|---|
| `/pause` | O sohbette ikizi durdurur. **Bekleyen hazır cevap varsa iptal edilir.** |
| `/resume` | İkiz sohbetin tamamını (senin Instagram'dan yazdıklarınla birlikte) baştan okur ve devam eder. Müşterinin cevapsız mesajı varsa birazdan yazar. |
| `/durum` | Açık sohbetler ve hangisinde ikizin çalıştığı. |

**Hangi müşteri olduğunu nasıl anlıyor:** bildirime **kaydırıp yanıtla** ile komut
yazarsın, ya da bildirimin altındaki **düğmeye** basarsın. Düz `/pause` yazarsan en son
mesaj gelen müşteriye uygulanır.

### İkiz ne zaman kendiliğinden durur
Üç durumda — ve hepsinde **sen `/resume` diyene kadar susar**, kendiliğinden geri gelmez:
1. Müşteri **fotoğraf** gönderdiğinde (fotoğraf Telegram'a düşer, müşteriye hiçbir şey yazılmaz).
2. **Sen Instagram'dan** o müşteriye yazdığında (sohbeti devraldın demektir).
3. "Bana devret" tetikleyicisi çalıştığında (ör. müşteri "şikayet" yazdı).

Her üçünde de Telegram'a "ikiz durdu" bildirimi gelir, unutma diye.

### Kurulum

**1) Ön şartlar:** Instagram hesabın **Business/Creator** olmalı ve bir Facebook
sayfasına bağlı olmalı.

**2) Supabase şeması:** `supabase/schema.sql` dosyasının sonundaki *Instagram DM kanalı*
bloğunu SQL Editor'de çalıştır (`ig_threads`, `ig_messages` tabloları). Tekrar
çalıştırmak güvenli.

**3) Meta uygulaması:** https://developers.facebook.com > Create App > **Business**.
Sol menüden **Instagram > API setup with Instagram login**:
   - Instagram hesabını bağla.
   - İzinler: `instagram_business_basic` + `instagram_business_manage_messages`
     + `instagram_business_manage_comments` (yorum tetikleyicileri için).
   - "Generate token" ile **uzun ömürlü erişim anahtarını** al → `.env` içinde `IG_ACCESS_TOKEN`.
   - **App Settings > Basic > App Secret** → `.env` içinde `IG_APP_SECRET`.
   - `IG_VERIFY_TOKEN` için kendin bir parola uydur (ör. `qneed-2026-gizli`).

**4) Tünel aç** (Meta'nın bilgisayarına ulaşabilmesi için public HTTPS adres gerekli):
```
cloudflared tunnel --url http://localhost:3940
```
Ekrandaki `https://xxxx.trycloudflare.com` adresini kopyala. (Alternatif: `ngrok http 3940`.)
Ücretsiz tünel adresi her açılışta değişir — değişince Meta panosunda güncellemen gerekir.

**5) Sunucuyu başlat:**
```
npm run instagram
```
(ya da `BASLAT-INSTAGRAM.bat`)

**6) Webhook'u kaydet:** Meta panosunda Instagram > Webhooks:
   - Callback URL: `https://xxxx.trycloudflare.com/webhook`
   - Verify token: `.env`'deki `IG_VERIFY_TOKEN` ile **aynı**
   - Doğrula ve **`messages`** + **`comments`** alanlarına abone ol.
   - Sunucu penceresinde `Webhook doğrulandı ✔` görmelisin.

**7) Dene:** başka bir hesaptan işletme hesabına DM at.

### Kontrol paneli
Ayarların hepsi **ana arayüzde**: `npm run ui` → **Instagram** sekmesi. Oradan
tetikleyici kelimeleri yönetir, gelen yorumları ve sohbetleri görür, istediğin
sohbette ikizi kapatırsın. (`http://localhost:3940/durum` sadece "sunucu ayakta mı"
bilgisi verir ve arayüze yönlendirir.)

İki pencere birlikte çalışır: `npm run instagram` **motor** (DM'leri işler),
`npm run ui` **kumanda** (ayarlar). Arayüz, motorun açık olup olmadığını gösterir.

## Tetikleyici kelimeler

Belirlediğin kelimeyi yazana otomatik davranış. İki yerde çalışır: **gönderi
yorumlarında** ("fiyat yaz, DM'den anlatayım" akışı) ve **gelen DM'de** (sık sorulan
şeye anında cevap). Arayüz → Instagram sekmesi → *Tetikleyici ekle*.

Her kuralda iki ana seçim var:

**1) Nerede çalışsın:** Gönderi yorumları · Gelen DM · İkisi de

**2) Ne yapsın:**

| Seçenek | Ne olur |
|---|---|
| **İkiz kendi yazsın** | Yoruma özel bir açılış mesajı yazıp DM atar, sonra normal satış sohbeti sürer. Hazır metin yok, tarz senin konuşmalarından. *(Yorumlar için varsayılan.)* |
| **Hazır mesaj gönder** | Yazdığın metin aynen gider, ikiz karışmaz. Sık sorulan şeyler için: "kargo" → "siparişler 2-3 günde elinizde". |
| **Ürün fotoğrafı gönder** | Katalogdan seçtiğin ürünün fotoğrafını yollar (istersen önce kısa bir metin). |
| **Bana devret** | İkiz susar, sohbet sana kalır. Şikâyet/iade gibi kelimeler için: "sikayet" → ikiz karışmaz. |

Diğer alanlar: **Gönderi ID** (boş = tüm gönderiler; sadece yorumlarda anlamlı) ·
**Mesaj metni** (seçilen aksiyona göre anlamı değişir, arayüz açıklıyor) ·
**Yorumun altına** (herkesin göreceği kısa cevap, ör. "dm'den yazdım").

**Kelime seçimi.** Kısa, tek kelimelik ve insanların kendiliğinden yazacağı şeyler
seç: **`fiyat`**, **`bilgi`**, **`link`**, **`istiyorum`**. Gönderinin altına da
mutlaka yaz: *"fiyat yazın, DM'den anlatayım"* — yoksa kimse tetiklemeyi bilmez.
Kampanyaya özel tek kelime de kullanabilirsin (ör. `temmuz`), böylece hangi gönderiden
geldiğini ayırt edersin.

Eşleştirme büyük/küçük harf ve Türkçe karakter duyarsız, ekli halleri de yakalar:
`fiyat` → "Fiyat?", "FİYAT", "fiyatı ne kadar", "💕fiyat💕" hepsi tetikler.
Alakasız kelimenin ortasına denk gelmez. `*` yazarsan her yorum/mesaj tetikler
(gerçek kelimeler her zaman `*`'dan önce denenir).

**Yorum tetikleyicilerinde Meta'nın sert kuralları** (bunlar bizim değil, Instagram'ın
sınırı — DM tetikleyicilerinde bu kısıtlar yok):
- Yorum başına **ömür boyu tek** DM hakkı. İkinci kez denenmez (kod bunu takip ediyor).
- Yorum **7 günden** eskiyse DM gönderilemez.
- Sadece **kendi gönderindeki ana yorumlar**. Bir yoruma gelen cevaplar tetikleyemez.
- Kişi seni takip etmiyorsa mesaj **"İstekler"** klasörüne düşer — normal, oradan da okunuyor.
- Zaten son 24 saatte konuştuğun biri yoruma yazarsa hazır mesajla araya girmiyoruz,
  sohbet kaldığı yerden devam ediyor.

Ne olduğunu panelin *Son yorumlar* tablosundan görürsün: DM gitti mi, gitmediyse neden
(tetikleyici yok / cevap yorumu / 7 gün geçmiş vb.).

### Bilmen gereken sınırlar
- **24 saat kuralı:** müşteri sana yazmadan sen ona yazamazsın. Soğuk mesaj/kampanya yok
  (WhatsApp'ta ücretli şablonla bu aşılabiliyor, Instagram'da yok).
- **App review:** kendi hesabında test ederken sorun yok; başka hesaplara açılacaksa
  Meta'dan izin onayı (app review) gerekiyor.
- **AB kısıtı:** Meta, AB'deki kullanıcılarda DM medya özelliklerini kapatmış durumda;
  karşı taraf AB'deyse fotoğraf gönderimi hata verebilir. Türkiye etkilenmiyor.
- Bilgisayar kapalıyken ikiz cevap veremez. Sürekli açık olması gerekiyorsa küçük bir
  sunucuya (Railway/Fly/VPS) taşımak gerekir.

## Sıradaki fazlar
- Faz 2b: WhatsApp (Business Cloud API) — aynı adaptör deseni, `brain.ts` değişmez.
- Faz 3: Sipariş tamamlama + ödeme linki (iyzico/PayTR) + insana devir.
- Faz 4: Öğrenme döngüsü — iyi giden Instagram sohbetlerini tek tıkla eğitim verisine çevir.
- Ürün fotoğrafını sohbet sırasında gönderme (Claude'a `urun_fotografi_gonder` aracı;
  gönderim altyapısı `sendImage` olarak hazır, tetikleme henüz bağlı değil).
