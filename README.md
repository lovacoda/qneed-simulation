# qneed — AI İkiz (Faz 1.5: RAG Beyin)

Kişilik klonu satış AI'ı. Bu faz **beyni** kuruyor: senin tarzınla konuşup satış yapmaya
çalışan bir sohbet motoru + geçmiş konuşmalarını biriktireceğin Supabase deposu.
WhatsApp entegrasyonu sonraki faz.

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
Tarayıcıda `http://localhost:3939` açılır. Üç sekme:
1. **Veri Girişi** — konuşma ve ürün ekle/düzenle/sil (doğrudan Supabase'e yazar).
   Konuşmada "Örnek olarak kullan" işaretlersen ikiz o tarzı taklit eder.
2. **Test Simülasyonu** — müşteri gibi yaz, ikiz cevaplasın. Her mesajda o mesaja en uygun
   konuşmalar anlamsal aramayla seçilip sistem promptu yeniden kurulur; yeni eklediğin veri
   anında etkiler.
3. **Sistem Promptu** — ana talimatları (rol + oyun kitabı + kurallar) düzenle-kaydet, kurulan
   tam promptu gör.

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

## Sıradaki fazlar
- Faz 2: WhatsApp (Business Cloud API) — mesaj al/gönder, oturum yönetimi.
- Faz 3: Sipariş tamamlama + ödeme linki (iyzico/PayTR) + insana devir.
- Faz 4: Öğrenme döngüsü — `chat_logs` + sonuç etiketi ile ikizi keskinleştir.
