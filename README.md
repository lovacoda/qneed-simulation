# qneed — AI İkiz (Faz 1: Beyin)

Kişilik klonu satış AI'ı. Bu faz **beyni** kuruyor: senin tarzınla konuşup satış yapmaya
çalışan bir sohbet motoru + geçmiş konuşmalarını biriktireceğin Supabase deposu.
WhatsApp entegrasyonu sonraki faz.

## Ne var
- **Arayüz** (`npm run ui`): tarayıcıda açılan 3 sekmeli kontrol panosu — Veri Girişi / Test Simülasyonu / Sistem Promptu.
- **Supabase**: `conversations` (geçmiş satış diyalogların), `messages`, `products` (katalog), `chat_logs` (ikizin kendi görüşmeleri).
- **Beyin**: `data/persona.md` (senin yazışma tarzın) + satış oyun kitabı + güvenlik kuralları + katalog + gerçek konuşma örneklerinden bir sistem promptu kurar; Claude ile sohbet eder.
- **Ingest** (`npm run ingest`): `data/` altındaki `.md` dosyalarını toplu olarak Supabase'e yükler.

## Kurulum

1) Bağımlılıklar (bir kez):
```
npm install
```

2) Ortam değişkenleri: `.env.example` dosyasını `.env` olarak kopyala, doldur.
   - `ANTHROPIC_API_KEY` → https://console.anthropic.com > API Keys
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` → Supabase panelinde Project Settings > Data API / API Keys
     (service_role anahtarı gizli; sadece bu sunucu tarafı projede kullan).

3) Supabase şeması: Supabase panelinde SQL Editor'e `supabase/schema.sql` içeriğini yapıştır ve çalıştır.

## Kullanım — Arayüz (önerilen)

```
npm run ui
```
Tarayıcıda `http://localhost:3939` açılır. Üç sekme:
1. **Veri Girişi** — konuşma ve ürün ekle/düzenle/sil (doğrudan Supabase'e yazar).
   Konuşmada "Örnek olarak kullan" işaretlersen ikiz o tarzı taklit eder.
2. **Test Simülasyonu** — müşteri gibi yaz, ikiz cevaplasın. Her mesajda güncel veriyle
   (katalog + örnekler) sistem promptu yeniden kurulur, yani yeni eklediğin veri anında etkiler.
3. **Sistem Promptu** — personayı (yazışma tarzını) düzenle-kaydet, kurulan tam promptu gör.

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

## Sıradaki fazlar
- Faz 2: WhatsApp (Business Cloud API) — mesaj al/gönder, oturum yönetimi.
- Faz 3: Sipariş tamamlama + ödeme linki (iyzico/PayTR) + insana devir.
- Faz 4: Öğrenme döngüsü — `chat_logs` + sonuç etiketi ile ikizi keskinleştir.
- İleride: `products`/`conversations` üzerine pgvector ile anlamsal arama (veri büyüyünce).
