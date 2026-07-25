import dotenv from 'dotenv';

dotenv.config();

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
export const MODEL = process.env.MODEL ?? 'claude-opus-4-8';

// Embedding (anlam parmak izi) — konuşmaları duruma göre bulmak için (RAG).
// Sağlayıcı Voyage AI (Anthropic önerisi). Değiştirmek istenirse embed.ts tek yer.
export const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
export const EMBED_MODEL = process.env.EMBED_MODEL ?? 'voyage-3.5';
export const EMBED_DIM = Number(process.env.EMBED_DIM ?? 1024);

// --- Instagram DM kanalı ----------------------------------------------------
export const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
export const IG_APP_SECRET = process.env.IG_APP_SECRET;
export const IG_VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN;
// Mesajı hangi hesap adına göndereceğiz. 'me' token'ın sahibi hesabı kullanır.
export const IG_ACCOUNT_ID = process.env.IG_ACCOUNT_ID ?? 'me';
// Instagram Login akışı graph.instagram.com kullanır; Facebook Login ile
// bağlanan eski kurulumlarda graph.facebook.com yazılır.
export const IG_GRAPH_HOST = process.env.IG_GRAPH_HOST ?? 'graph.instagram.com';
export const IG_GRAPH_VERSION = process.env.IG_GRAPH_VERSION ?? 'v23.0';
// Otomatik cevap ana şalteri (tek tek sohbetler için ig_threads.auto_reply var).
export const IG_AUTO_REPLY = (process.env.IG_AUTO_REPLY ?? 'true').toLowerCase() !== 'false';
// Claude'a taşınan geçmiş mesaj sayısı.
export const IG_HISTORY_LIMIT = Number(process.env.IG_HISTORY_LIMIT ?? 20);
export const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT ?? 3940);

// --- Mesaj biriktirme (insan gibi cevap vermek için) ------------------------
// Müşteri alt alta 5 mesaj atarsa 5 ayrı cevap yazmak yerine susup bekler,
// sustuğunda hepsini birden okuyup TEK cevap yazar.
// Son mesajdan sonra beklenecek sessizlik (saniye, aralıktan rastgele).
export const IG_WAIT_MIN_SEC = Number(process.env.IG_WAIT_MIN_SEC ?? 45);
export const IG_WAIT_MAX_SEC = Number(process.env.IG_WAIT_MAX_SEC ?? 90);
// Müşteri hiç susmazsa en geç ne zaman cevap verilecek (ilk mesajdan itibaren, sn).
export const IG_WAIT_CEILING_SEC = Number(process.env.IG_WAIT_CEILING_SEC ?? 300);
// Cevap gönderilmeden önce "yazıyor..." süresi (sn) — uzun cevapta daha uzun.
export const IG_TYPING_MIN_SEC = Number(process.env.IG_TYPING_MIN_SEC ?? 5);
export const IG_TYPING_MAX_SEC = Number(process.env.IG_TYPING_MAX_SEC ?? 20);

// --- Telegram kumandası -----------------------------------------------------
// BotFather'dan alınan token. Yoksa Telegram tarafı hiç çalışmaz (gerisi çalışır).
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Sadece bu sohbet komut verebilir. Boşsa ilk yazan kişi öğrenilir ve loglanır.
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
