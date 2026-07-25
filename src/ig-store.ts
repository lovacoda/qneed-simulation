// Instagram DM konuşma hafızası (Supabase). Her müşteri = bir "thread",
// her mesaj = bir satır. Beynin RAG deposundan (conversations/messages)
// ayrı tutuluyor: burası CANLI sohbet, orası EĞİTİM verisi.
import type { SupabaseClient } from '@supabase/supabase-js';

export type IgRole = 'customer' | 'assistant' | 'human';

export interface IgThread {
  id: string;
  ig_user_id: string;
  username: string | null;
  auto_reply: boolean;
  // Tetikleyici kelime gelene kadar false: ikiz o sohbete hiç yazmaz.
  unlocked: boolean;
  paused_until: string | null;
  last_message_at: string | null;
}

export async function findThread(
  supabase: SupabaseClient,
  igUserId: string,
): Promise<IgThread | null> {
  const { data } = await supabase
    .from('ig_threads')
    .select('*')
    .eq('ig_user_id', igUserId)
    .maybeSingle();
  return (data as IgThread) ?? null;
}

export async function getOrCreateThread(
  supabase: SupabaseClient,
  igUserId: string,
): Promise<IgThread> {
  const { data: found } = await supabase
    .from('ig_threads')
    .select('*')
    .eq('ig_user_id', igUserId)
    .maybeSingle();
  if (found) return found as IgThread;

  const { data, error } = await supabase
    .from('ig_threads')
    .insert({ ig_user_id: igUserId })
    .select('*')
    .single();
  // Aynı anda iki mesaj geldiyse ikinci insert çakışır; o zaman okuyup dönüyoruz.
  if (error) {
    const { data: again } = await supabase
      .from('ig_threads')
      .select('*')
      .eq('ig_user_id', igUserId)
      .maybeSingle();
    if (again) return again as IgThread;
    throw new Error(error.message);
  }
  return data as IgThread;
}

export interface IgMessageInput {
  thread_id: string;
  mid?: string | null;
  role: IgRole;
  text: string;
  image_url?: string | null;
}

// Mesajı kaydeder. Meta aynı webhook'u tekrar gönderebildiği için `mid`
// benzersiz: aynı mid ikinci kez gelirse false döner (= zaten işlenmiş).
export async function recordMessage(
  supabase: SupabaseClient,
  input: IgMessageInput,
): Promise<boolean> {
  const row = {
    thread_id: input.thread_id,
    mid: input.mid ?? null,
    role: input.role,
    text: input.text,
    image_url: input.image_url ?? null,
  };
  if (row.mid) {
    const { data, error } = await supabase
      .from('ig_messages')
      .upsert(row, { onConflict: 'mid', ignoreDuplicates: true })
      .select('id');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return false; // tekrar gelen webhook
  } else {
    const { error } = await supabase.from('ig_messages').insert(row);
    if (error) throw new Error(error.message);
  }
  await supabase
    .from('ig_threads')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', input.thread_id);
  return true;
}

// Bu mid'i biz mi göndermiştik? (Kendi mesajımızın echo'sunu insan yazmış
// gibi algılayıp otomatik cevabı durdurmamak için.)
export async function isKnownMid(supabase: SupabaseClient, mid: string): Promise<boolean> {
  const { data } = await supabase.from('ig_messages').select('id').eq('mid', mid).maybeSingle();
  return !!data;
}

export interface IgTurn {
  role: IgRole;
  text: string;
  image_url?: string | null;
}

// Sohbetin son N mesajı (eskiden yeniye). Claude'a bağlam olarak gider.
export async function loadHistory(
  supabase: SupabaseClient,
  threadId: string,
  limit: number,
): Promise<IgTurn[]> {
  const { data } = await supabase
    .from('ig_messages')
    .select('role,text,image_url')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return ((data ?? []) as IgTurn[]).reverse();
}

// Durdurma/devam ettirme. Süreli duraklatma yok: ikiz sen /resume diyene
// kadar susar (paused_until eski kurulumlardan kalan kayıtlar için temizlenir).
// Sohbeti ikize açar (tetikleyici kelime geldiğinde ya da DM'i biz başlattığımızda).
export async function unlockThread(supabase: SupabaseClient, threadId: string): Promise<void> {
  const { error } = await supabase.from('ig_threads').update({ unlocked: true }).eq('id', threadId);
  if (error) throw new Error(error.message);
}

export async function setAutoReply(
  supabase: SupabaseClient,
  threadId: string,
  on: boolean,
): Promise<void> {
  await supabase
    .from('ig_threads')
    .update({ auto_reply: on, paused_until: null })
    .eq('id', threadId);
}

export function threadIsMuted(thread: IgThread): boolean {
  if (!thread.auto_reply) return true;
  if (thread.paused_until && new Date(thread.paused_until).getTime() > Date.now()) return true;
  return false;
}

// --- Telegram eşlemesi ------------------------------------------------------

export async function linkTelegramMessage(
  supabase: SupabaseClient,
  tgMessageId: number,
  threadId: string,
): Promise<void> {
  await supabase
    .from('tg_links')
    .upsert({ tg_message_id: tgMessageId, thread_id: threadId }, { onConflict: 'tg_message_id' });
}

export async function threadByTelegramMessage(
  supabase: SupabaseClient,
  tgMessageId: number,
): Promise<IgThread | null> {
  const { data } = await supabase
    .from('tg_links')
    .select('thread_id')
    .eq('tg_message_id', tgMessageId)
    .maybeSingle();
  if (!data?.thread_id) return null;
  return threadById(supabase, data.thread_id as string);
}

export async function threadById(
  supabase: SupabaseClient,
  id: string,
): Promise<IgThread | null> {
  const { data } = await supabase.from('ig_threads').select('*').eq('id', id).maybeSingle();
  return (data as IgThread) ?? null;
}

// En son mesaj gelen sohbet — Telegram'da düz "/pause" yazıldığında kullanılır.
export async function latestThread(supabase: SupabaseClient): Promise<IgThread | null> {
  const { data } = await supabase
    .from('ig_threads')
    .select('*')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  return (data as IgThread) ?? null;
}

// --- Yorum olayları ---------------------------------------------------------

// Yorumu "ben aldım" diye işaretler. Aynı yorum ikinci kez gelirse false döner
// (Meta webhook'u tekrarlayabiliyor; yorum başına tek DM hakkımız var,
// boşa harcamayalım).
export async function claimComment(
  supabase: SupabaseClient,
  c: {
    comment_id: string;
    ig_user_id: string;
    username?: string | null;
    media_id?: string | null;
    text: string;
  },
): Promise<boolean> {
  const { data, error } = await supabase
    .from('ig_comments')
    .upsert(
      {
        comment_id: c.comment_id,
        ig_user_id: c.ig_user_id,
        username: c.username ?? null,
        media_id: c.media_id ?? null,
        text: c.text,
      },
      { onConflict: 'comment_id', ignoreDuplicates: true },
    )
    .select('id');
  if (error) throw new Error(error.message);
  return !!data && data.length > 0;
}

export async function markComment(
  supabase: SupabaseClient,
  commentId: string,
  patch: { matched_keyword?: string | null; dm_sent?: boolean; skipped_reason?: string | null },
): Promise<void> {
  await supabase.from('ig_comments').update(patch).eq('comment_id', commentId);
}

export async function listComments(supabase: SupabaseClient, limit = 20) {
  const { data } = await supabase
    .from('ig_comments')
    .select('comment_id,username,text,matched_keyword,dm_sent,skipped_reason,created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}

export async function listThreads(supabase: SupabaseClient) {
  const { data } = await supabase
    .from('ig_threads')
    .select('id,ig_user_id,username,auto_reply,unlocked,paused_until,last_message_at')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(50);
  return data ?? [];
}
