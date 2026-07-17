// Supabase okuma/yazma katmanı. Hem CLI ingest hem web arayüzü aynı fonksiyonları kullanır.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Msg } from './parse';
import { embedOne, embeddingEnabled } from './embed';
import { deleteProductImage } from './storage';

export interface ConversationInput {
  slug: string;
  title?: string | null;
  channel?: string | null;
  outcome?: string | null;
  is_exemplar?: boolean;
  quality?: number;
  tags?: string[];
  notes?: string | null;
  happened_at?: string | null;
  dialog: Msg[];
}

export async function upsertConversation(
  supabase: SupabaseClient,
  input: ConversationInput,
): Promise<string> {
  const conv = {
    slug: input.slug,
    title: input.title ?? input.slug,
    channel: input.channel ?? 'whatsapp',
    outcome: input.outcome ?? 'unknown',
    is_exemplar: input.is_exemplar ?? false,
    quality: input.quality ?? 3,
    tags: input.tags ?? [],
    notes: input.notes ?? null,
    happened_at: input.happened_at || null,
  };
  const { data: up, error } = await supabase
    .from('conversations')
    .upsert(conv, { onConflict: 'slug' })
    .select('id')
    .single();
  if (error || !up) throw new Error(error?.message ?? 'konuşma kaydedilemedi');
  const id = up.id as string;

  // Mesajları tazele (idempotent yeniden kayıt).
  await supabase.from('messages').delete().eq('conversation_id', id);
  if (input.dialog.length) {
    const rows = input.dialog.map((m, i) => ({
      conversation_id: id,
      position: i,
      speaker: m.speaker,
      text: m.text,
    }));
    const { error: mErr } = await supabase.from('messages').insert(rows);
    if (mErr) throw new Error(mErr.message);
  }

  // Anlam parmak izini tazele. En iyi çaba: anahtar yoksa ya da servis hata
  // verirse kayıt yine de tamamlanır; parmak izi `npm run embed` ile doldurulur.
  if (embeddingEnabled()) {
    try {
      await updateConversationEmbedding(supabase, id, input.dialog);
    } catch (e) {
      console.warn(
        `[embed] "${input.slug}" gömülemedi (kayıt tamam): ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  return id;
}

// Konuşmanın parmak izini üretip yazar. Retrieval anahtarı olarak MÜŞTERİNİN
// anlattığı durumu kullanırız — gelen sorgu da bir müşteri mesajı olduğu için
// en isabetli eşleşme bu. Müşteri metni yoksa tüm diyaloğa düşeriz.
export function conversationEmbedText(dialog: Msg[]): string {
  const customer = dialog
    .filter((m) => m.speaker === 'customer')
    .map((m) => m.text)
    .join('\n')
    .trim();
  if (customer) return customer;
  return dialog
    .map((m) => m.text)
    .join('\n')
    .trim();
}

export async function updateConversationEmbedding(
  supabase: SupabaseClient,
  id: string,
  dialog: Msg[],
): Promise<boolean> {
  const text = conversationEmbedText(dialog);
  if (!text) return false;
  const vec = await embedOne(text, 'document');
  const { error } = await supabase.from('conversations').update({ embedding: vec }).eq('id', id);
  if (error) throw new Error(error.message);
  return true;
}

export interface ConversationMatch {
  id: string;
  title: string | null;
  outcome: string | null;
  similarity: number;
}

// Sorgu vektörüne en yakın konuşmaları döndürür (pgvector RPC — schema.sql).
export async function matchConversations(
  supabase: SupabaseClient,
  queryEmbedding: number[],
  matchCount: number,
): Promise<ConversationMatch[]> {
  const { data, error } = await supabase.rpc('match_conversations', {
    query_embedding: queryEmbedding,
    match_count: matchCount,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as ConversationMatch[];
}

export interface ProductInput {
  slug: string;
  name: string;
  price?: number | null;
  currency?: string;
  category?: string | null;
  good_for?: string | null;
  description?: string | null;
  image_url?: string | null;
}

export async function upsertProduct(supabase: SupabaseClient, p: ProductInput): Promise<void> {
  const row: Record<string, unknown> = {
    slug: p.slug,
    name: p.name,
    price: p.price ?? null,
    currency: p.currency ?? 'TRY',
    category: p.category ?? null,
    good_for: p.good_for ?? null,
    description: p.description ?? null,
  };
  // image_url yalnızca çağıran belirtmişse yazılır. undefined = "dokunma" —
  // böylece md dosyalarından çalışan ingest, arayüzden eklenmiş bir görseli
  // silmez. null = "kaldır" (arayüzdeki 'Görseli kaldır' düğmesi).
  if (p.image_url !== undefined) row.image_url = p.image_url;

  const { error } = await supabase.from('products').upsert(row, { onConflict: 'slug' });
  if (error) throw new Error(error.message);
}

// Kayıt öncesi eski görseli bilmek için (değişmişse eskisini silebilelim).
export async function getProductBySlug(supabase: SupabaseClient, slug: string) {
  const { data } = await supabase.from('products').select('*').eq('slug', slug).maybeSingle();
  return data;
}

export async function listConversations(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('conversations')
    .select('id,slug,title,channel,outcome,is_exemplar,quality,tags,messages(count)')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((c: Record<string, any>) => ({
    id: c.id,
    slug: c.slug,
    title: c.title,
    channel: c.channel,
    outcome: c.outcome,
    is_exemplar: c.is_exemplar,
    quality: c.quality,
    tags: c.tags ?? [],
    message_count: Array.isArray(c.messages) && c.messages[0] ? c.messages[0].count : 0,
  }));
}

export async function getConversation(supabase: SupabaseClient, id: string) {
  const { data: conversation, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw new Error(error.message);
  const { data: dialog } = await supabase
    .from('messages')
    .select('speaker,text')
    .eq('conversation_id', id)
    .order('position');
  return { conversation, dialog: dialog ?? [] };
}

export async function deleteConversation(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from('conversations').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function listProducts(supabase: SupabaseClient) {
  const { data, error } = await supabase.from('products').select('*').order('name');
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function deleteProduct(supabase: SupabaseClient, id: string): Promise<void> {
  const { data: prev } = await supabase.from('products').select('image_url').eq('id', id).maybeSingle();
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) throw new Error(error.message);
  await deleteProductImage(supabase, prev?.image_url);
}
