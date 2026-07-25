// Yorum tetikleyicileri: "gönderiye şu kelimeyi yazana DM at" kuralları.
// Kurallar Supabase'de (ig_triggers) durur, kontrol panelinden yönetilir.
import type { SupabaseClient } from '@supabase/supabase-js';

// Tetikleyici nerede çalışır: gönderi yorumlarında, gelen DM'de ya da ikisinde.
export type TriggerSource = 'comment' | 'dm' | 'both';
// Tetiklenince ne olur:
//   ai       → ikiz duruma uygun cevabı kendi yazar (varsayılan)
//   reply    → hazır metin gider, ikiz karışmaz
//   product  → seçilen ürünün fotoğrafı (+ varsa hazır metin) gider
//   handover → ikiz susar, sohbeti sen devralırsın
export type TriggerAction = 'ai' | 'reply' | 'product' | 'handover';

export interface Trigger {
  id: string;
  keyword: string; // normalize edilmiş hali saklanır
  source: TriggerSource;
  action: TriggerAction;
  media_id: string | null; // null = bütün gönderiler (yalnızca yorumlarda anlamlı)
  dm_text: string | null; // null = mesajı ikiz yazsın
  public_reply: string | null; // null = yorumun altına cevap yazma
  product_slug: string | null; // action='product' ise gönderilecek ürün
  active: boolean;
}

const TR_MAP: Record<string, string> = {
  ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u',
  Ç: 'c', Ğ: 'g', İ: 'i', I: 'i', Ö: 'o', Ş: 's', Ü: 'u',
};

// Karşılaştırma için sadeleştirir: Türkçe harfler, büyük/küçük, noktalama ve
// emoji ayıklanır. "FİYAT?? 😍" ve "fiyat" aynı şeye dönüşür.
export function normalize(s: string): string {
  return s
    .split('')
    .map((ch) => TR_MAP[ch] ?? ch)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tetikleyici, yorumdaki bir kelimenin BAŞINDA geçiyorsa eşleşir.
// Türkçe ekli halleri de yakalar: "fiyat" → "fiyatı", "fiyata", "fiyat?" ✔
// Ama alakasız kelimenin ortasına denk gelmez: "bilgi" → "değişikligi" ✘
// Özel durum: "*" = o gönderiye gelen HER yorum tetikler.
export function matches(commentText: string, keyword: string): boolean {
  // '*' kontrolü normalize'dan ÖNCE: normalize noktalama işaretlerini siliyor.
  if (keyword.trim() === '*') return true;
  const k = normalize(keyword);
  if (!k) return false;
  const words = normalize(commentText).split(' ').filter(Boolean);
  // Çok kelimeli tetikleyici ("bilgi ver") → düz arama.
  if (k.includes(' ')) return normalize(commentText).includes(k);
  return words.some((w) => w.startsWith(k));
}

// Uzun kelime daha spesifiktir; önce onu dene ("fiyat listesi" > "fiyat").
// '*' (her şey) en sona kalsın ki gerçek kelimeler öncelikli olsun.
function firstMatch(list: Trigger[], text: string): Trigger | null {
  const sorted = [...list].sort((a, b) => {
    if (a.keyword === '*') return 1;
    if (b.keyword === '*') return -1;
    return b.keyword.length - a.keyword.length;
  });
  return sorted.find((t) => matches(text, t.keyword)) ?? null;
}

// Metne uyan ilk kuralı bulur. Yorumlarda gönderiye özel kural genel kuralı ezer.
export function pickTrigger(
  triggers: Trigger[],
  text: string,
  mediaId: string | null,
  source: 'comment' | 'dm',
): Trigger | null {
  const usable = triggers.filter((t) => t.active && (t.source === source || t.source === 'both'));
  if (source === 'dm') return firstMatch(usable, text);
  const scoped = usable.filter((t) => t.media_id && t.media_id === mediaId);
  const global = usable.filter((t) => !t.media_id);
  return firstMatch(scoped, text) ?? firstMatch(global, text);
}

export async function listTriggers(supabase: SupabaseClient): Promise<Trigger[]> {
  const { data, error } = await supabase
    .from('ig_triggers')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Trigger[];
}

export interface TriggerInput {
  keyword: string;
  source?: TriggerSource;
  action?: TriggerAction;
  media_id?: string | null;
  dm_text?: string | null;
  public_reply?: string | null;
  product_slug?: string | null;
}

export async function addTrigger(supabase: SupabaseClient, input: TriggerInput): Promise<void> {
  const keyword = input.keyword.trim() === '*' ? '*' : normalize(input.keyword);
  if (!keyword) throw new Error('Tetikleyici kelime boş olamaz.');
  const source: TriggerSource = input.source ?? 'comment';
  const action: TriggerAction = input.action ?? 'ai';
  // Eksik ayarla kaydedip canlıda sessizce çalışmamasındansa burada uyaralım.
  if (action === 'reply' && !input.dm_text?.trim()) {
    throw new Error('"Hazır mesaj" seçtiysen mesaj metnini yazmalısın.');
  }
  if (action === 'product' && !input.product_slug) {
    throw new Error('"Ürün fotoğrafı" seçtiysen bir ürün seçmelisin.');
  }
  if (source === 'dm' && action === 'ai') {
    throw new Error('DM tetikleyicisinde "ikiz yazsın" anlamsız — ikiz zaten cevaplıyor.');
  }
  const { error } = await supabase.from('ig_triggers').insert({
    keyword,
    source,
    action,
    media_id: input.media_id || null,
    dm_text: input.dm_text || null,
    public_reply: input.public_reply || null,
    product_slug: input.product_slug || null,
  });
  if (error) throw new Error(error.message);
}

export async function toggleTrigger(
  supabase: SupabaseClient,
  id: string,
  active: boolean,
): Promise<void> {
  const { error } = await supabase.from('ig_triggers').update({ active }).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteTrigger(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from('ig_triggers').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
