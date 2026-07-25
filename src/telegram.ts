// Telegram kumandası: müşteri mesajlarını sana iletir, sen /pause - /resume
// ile ikizi yönetirsin. Instagram'ın aksine tünel gerekmiyor — bot dışarı
// doğru bağlanıp bekliyor (long polling).
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from './config';

const API = 'https://api.telegram.org/bot';

export function telegramEnabled(): boolean {
  return !!TELEGRAM_BOT_TOKEN;
}

async function call(method: string, body: unknown): Promise<Record<string, any>> {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN tanımlı değil.');
  const res = await fetch(`${API}${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, any>;
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
  return json.result ?? {};
}

// Bildirimlerin altındaki düğmeler. callback_data 64 bayt sınırlı;
// "p:<uuid>" 38 bayt — rahat sığıyor.
function buttons(threadId: string, paused: boolean) {
  return {
    inline_keyboard: [
      [
        paused
          ? { text: '▶️ Devam et', callback_data: `r:${threadId}` }
          : { text: '⏸ Durdur', callback_data: `p:${threadId}` },
      ],
    ],
  };
}

export interface SentNotice {
  messageId: number | null;
}

// Bildirim gönderir. threadId verilirse altına düğme koyar ve dönen mesaj
// kimliğini kaydederiz — böylece o mesaja "kaydırıp yanıtla" ile komut
// yazınca hangi müşteriden bahsettiğin anlaşılır.
export async function notify(
  text: string,
  opts: { threadId?: string; paused?: boolean } = {},
): Promise<SentNotice> {
  if (!TELEGRAM_CHAT_ID) return { messageId: null };
  const res = await call('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    reply_markup: opts.threadId ? buttons(opts.threadId, !!opts.paused) : undefined,
    disable_web_page_preview: true,
  });
  return { messageId: typeof res.message_id === 'number' ? res.message_id : null };
}

// Müşterinin gönderdiği fotoğrafı Telegram'a iletir. Önce URL ile deneriz
// (Telegram kendi indirir); Meta linki kabul edilmezse elimizdeki baytları
// dosya olarak yükleriz.
export async function notifyPhoto(
  url: string,
  caption: string,
  opts: { threadId?: string; paused?: boolean; bytes?: Buffer; mediaType?: string } = {},
): Promise<SentNotice> {
  if (!TELEGRAM_CHAT_ID) return { messageId: null };
  const markup = opts.threadId ? buttons(opts.threadId, !!opts.paused) : undefined;
  try {
    const res = await call('sendPhoto', {
      chat_id: TELEGRAM_CHAT_ID,
      photo: url,
      caption,
      reply_markup: markup,
    });
    return { messageId: typeof res.message_id === 'number' ? res.message_id : null };
  } catch {
    if (!opts.bytes) throw new Error('fotoğraf iletilemedi');
    const form = new FormData();
    form.append('chat_id', String(TELEGRAM_CHAT_ID));
    form.append('caption', caption);
    if (markup) form.append('reply_markup', JSON.stringify(markup));
    form.append(
      'photo',
      new Blob([new Uint8Array(opts.bytes)], { type: opts.mediaType ?? 'image/jpeg' }),
      'foto.jpg',
    );
    const res = await fetch(`${API}${TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
    const json = (await res.json()) as Record<string, any>;
    if (!json.ok) throw new Error(`Telegram sendPhoto: ${json.description ?? res.status}`);
    const id = json.result?.message_id;
    return { messageId: typeof id === 'number' ? id : null };
  }
}

// Düğmeye basınca Telegram'daki "yükleniyor" halkasını durdurur.
export async function ackCallback(id: string, text?: string): Promise<void> {
  try {
    await call('answerCallbackQuery', { callback_query_id: id, text });
  } catch {
    /* kozmetik */
  }
}

// Düğmeye basıldıktan sonra aynı mesajın düğmesini karşıt hale çevirir
// (Durdur ↔ Devam et), böylece mevcut durum mesajda görünür.
export async function swapButtons(
  messageId: number,
  threadId: string,
  paused: boolean,
): Promise<void> {
  if (!TELEGRAM_CHAT_ID) return;
  try {
    await call('editMessageReplyMarkup', {
      chat_id: TELEGRAM_CHAT_ID,
      message_id: messageId,
      reply_markup: buttons(threadId, paused),
    });
  } catch {
    /* mesaj eski/silinmiş olabilir */
  }
}

// --- Gelen güncellemeler ----------------------------------------------------

export interface TgCommand {
  kind: 'command';
  chatId: number;
  text: string; // /pause, /resume, /durum ...
  replyToMessageId: number | null; // kaydırıp yanıtladıysa
}
export interface TgButton {
  kind: 'button';
  chatId: number;
  callbackId: string;
  data: string; // "p:<threadId>" | "r:<threadId>"
  messageId: number | null;
}
export type TgEvent = TgCommand | TgButton;

function authorized(chatId: number): boolean {
  if (!TELEGRAM_CHAT_ID) return false;
  return String(chatId) === String(TELEGRAM_CHAT_ID);
}

// Bota yazan ama yetkili olmayan kişileri sessizce yok sayarız; ilk kurulumda
// kendi chat id'ni öğrenmek için konsola yazdırıyoruz.
export function startPolling(
  onEvent: (e: TgEvent) => void,
  onLog: (s: string) => void,
): { stop: () => void } {
  let offset = 0;
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        const updates = (await call('getUpdates', { offset, timeout: 30 })) as unknown as any[];
        for (const u of updates ?? []) {
          offset = Math.max(offset, (u.update_id ?? 0) + 1);
          if (u.message?.text) {
            const chatId = u.message.chat?.id;
            if (!authorized(chatId)) {
              onLog(
                `Telegram: yetkisiz sohbetten mesaj (chat id: ${chatId}). ` +
                  `Bu senin hesabınsa .env içine TELEGRAM_CHAT_ID=${chatId} yaz.`,
              );
              continue;
            }
            onEvent({
              kind: 'command',
              chatId,
              text: String(u.message.text).trim(),
              replyToMessageId: u.message.reply_to_message?.message_id ?? null,
            });
          } else if (u.callback_query) {
            const q = u.callback_query;
            const chatId = q.message?.chat?.id;
            if (!authorized(chatId)) continue;
            onEvent({
              kind: 'button',
              chatId,
              callbackId: String(q.id),
              data: String(q.data ?? ''),
              messageId: q.message?.message_id ?? null,
            });
          }
        }
      } catch (e) {
        onLog(`Telegram bağlantı hatası: ${e instanceof Error ? e.message : e}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };
  void loop();
  return {
    stop: () => {
      running = false;
    },
  };
}
