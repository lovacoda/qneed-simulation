// Ürün görselleri: Supabase Storage'a yükler ve public URL döndürür.
// Public URL bilinçli bir tercih: kanal entegrasyonu (Instagram/WhatsApp) görseli
// doğrudan bu linkle gönderir, arada dönüştürme olmaz.
import type { SupabaseClient } from '@supabase/supabase-js';

export const PRODUCT_IMAGE_BUCKET = 'product-images';

// Instagram DM sınırı. Tarayıcı zaten 1080px'e küçültüyor; bu son savunma hattı.
const MAX_BYTES = 8 * 1024 * 1024;
const DATA_URL_RE = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/;
const PUBLIC_MARKER = `/storage/v1/object/public/${PRODUCT_IMAGE_BUCKET}/`;

export function isImageDataUrl(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('data:image/');
}

// Dosya adı her yüklemede benzersiz: CDN eski görseli önbellekten sunmasın.
function fileName(slug: string, ext: string): string {
  return `${slug}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

// Kova yoksa oluşturur. schema.sql de aynı kovayı kuruyor; bunu burada da
// yapıyoruz ki kurulum sırası ne olursa olsun ilk yükleme çalışsın.
let bucketReady = false;
async function ensureBucket(supabase: SupabaseClient): Promise<void> {
  if (bucketReady) return;
  const { error } = await supabase.storage.createBucket(PRODUCT_IMAGE_BUCKET, {
    public: true,
    allowedMimeTypes: ['image/png', 'image/jpeg'],
    fileSizeLimit: MAX_BYTES,
  });
  // Zaten varsa hata döner — beklenen durum, yutuyoruz.
  if (error && !/exist/i.test(error.message)) {
    throw new Error(`Storage kovası oluşturulamadı: ${error.message}`);
  }
  bucketReady = true;
}

export async function uploadProductImage(
  supabase: SupabaseClient,
  slug: string,
  dataUrl: string,
): Promise<string> {
  const m = DATA_URL_RE.exec(dataUrl.trim());
  if (!m) throw new Error('Görsel PNG ya da JPEG olmalı.');
  const contentType = m[1];
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_BYTES) {
    throw new Error(`Görsel 8 MB sınırını aşıyor (${(bytes.length / 1048576).toFixed(1)} MB).`);
  }
  await ensureBucket(supabase);
  const key = fileName(slug, contentType === 'image/png' ? 'png' : 'jpg');
  const { error } = await supabase.storage
    .from(PRODUCT_IMAGE_BUCKET)
    .upload(key, bytes, { contentType, upsert: false });
  if (error) throw new Error(`Görsel yüklenemedi: ${error.message}`);
  return supabase.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(key).data.publicUrl;
}

// Bizim kovamıza ait bir URL ise dosyayı siler. Dışarıdan yapıştırılmış bir
// linkse ya da silme başarısızsa sessizce geçer — kayıt akışını bozmamalı.
export async function deleteProductImage(
  supabase: SupabaseClient,
  url?: string | null,
): Promise<void> {
  if (!url) return;
  const i = url.indexOf(PUBLIC_MARKER);
  if (i === -1) return;
  const key = decodeURIComponent(url.slice(i + PUBLIC_MARKER.length));
  try {
    await supabase.storage.from(PRODUCT_IMAGE_BUCKET).remove([key]);
  } catch {
    /* yetim dosya kalması kayıttan daha az önemli */
  }
}
