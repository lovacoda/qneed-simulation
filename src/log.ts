import { getSupabase } from './supabase';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

// İkizin kendi görüşmesini Supabase'e kaydeder (öğrenme döngüsü için).
// Best-effort: tablo yoksa ya da bağlantı yoksa sessizce geçer.
export async function logSession(transcript: Turn[]): Promise<void> {
  if (transcript.length === 0) return;
  try {
    const supabase = getSupabase();
    await supabase.from('chat_logs').insert({ transcript });
  } catch {
    console.warn(
      "(Görüşme Supabase'e kaydedilemedi — chat_logs tablosu ya da bağlantı yok. Sorun değil.)",
    );
  }
}
