// Instagram DM kanalı — Graph API adaptörü.
// Beyin (brain.ts) bu dosyayı bilmez: burada sadece "mesaj al / mesaj gönder"
// işi var. WhatsApp eklendiğinde aynı arayüzle ikinci bir adaptör yazılır.
import crypto from 'node:crypto';
import {
  IG_ACCESS_TOKEN,
  IG_APP_SECRET,
  IG_ACCOUNT_ID,
  IG_GRAPH_HOST,
  IG_GRAPH_VERSION,
} from './config';

// Instagram DM metin sınırı 1000 karakter. Pay bırakıyoruz.
const TEXT_LIMIT = 950;
// Claude'a görsel verirken makul üst sınır (API sınırı ~5 MB base64).
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export function instagramEnabled(): boolean {
  return !!IG_ACCESS_TOKEN;
}

// path '/' ile başlar, ör. '/me/messages' ya da '/<yorum-id>/replies'
function graphUrl(path: string): string {
  return `https://${IG_GRAPH_HOST}/${IG_GRAPH_VERSION}${path}`;
}

const MESSAGES_PATH = `/${IG_ACCOUNT_ID}/messages`;

// Meta her webhook isteğini uygulama gizli anahtarıyla imzalar. Bu doğrulama
// olmadan URL'i bilen herkes sahte mesaj gönderebilir — bu yüzden anahtar
// yoksa isteği KABUL ETMİYORUZ (sessizce geçmek güvenlik açığı olurdu).
export function verifySignature(raw: Buffer, header: string | undefined): boolean {
  if (!IG_APP_SECRET || !header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', IG_APP_SECRET).update(raw).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

interface GraphError {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

async function post(path: string, body: unknown): Promise<Record<string, any>> {
  if (!IG_ACCESS_TOKEN) throw new Error('IG_ACCESS_TOKEN .env içinde tanımlı olmalı.');
  const res = await fetch(graphUrl(path), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${IG_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* JSON değilse aşağıda ham metni raporlarız */
  }
  if (!res.ok) {
    const e = (json as GraphError).error;
    const detail = e?.message ?? text.slice(0, 300);
    throw new Error(`Instagram API ${res.status}: ${detail}`);
  }
  return json;
}

// Uzun cevabı Instagram sınırına sığan parçalara böler. Önce paragraf, sonra
// cümle, en son kaba kesme — satıcı tarzı zaten kısa, bu bir emniyet kemeri.
export function splitForDm(text: string): string[] {
  const out: string[] = [];
  const pushChunk = (chunk: string) => {
    let rest = chunk.trim();
    while (rest.length > TEXT_LIMIT) {
      const window = rest.slice(0, TEXT_LIMIT);
      const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'), window.lastIndexOf(' '));
      const at = cut > TEXT_LIMIT * 0.5 ? cut + 1 : TEXT_LIMIT;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
  };
  for (const para of text.split(/\n{2,}/)) {
    if (para.trim()) pushChunk(para);
  }
  return out.length ? out : [];
}

export interface SentMessage {
  mid: string | null;
  text: string;
}

// Cevabı gönderir. Boş satırla ayrılmış paragraflar ayrı mesaj olarak gider
// (gerçek yazışma böyle görünür). Dönen mid'leri saklıyoruz ki kendi
// mesajımızın "echo" webhook'unu insan yazmış gibi algılamayalım.
export async function sendText(recipientId: string, text: string): Promise<SentMessage[]> {
  const sent: SentMessage[] = [];
  for (const chunk of splitForDm(text)) {
    const res = await post(MESSAGES_PATH, {
      recipient: { id: recipientId },
      message: { text: chunk },
    });
    sent.push({ mid: (res.message_id as string) ?? null, text: chunk });
  }
  return sent;
}

// Ürün görseli gönderimi. URL public HTTPS olmalı — Supabase Storage'daki
// products.image_url zaten bu formatta (bkz. src/storage.ts).
export async function sendImage(recipientId: string, url: string): Promise<SentMessage> {
  const res = await post(MESSAGES_PATH, {
    recipient: { id: recipientId },
    message: { attachment: { type: 'image', payload: { url, is_reusable: true } } },
  });
  return { mid: (res.message_id as string) ?? null, text: `[fotoğraf: ${url}]` };
}

// "Görüldü" ve "yazıyor..." göstergeleri. Başarısız olursa akışı bozmuyoruz.
export async function sendAction(
  recipientId: string,
  action: 'mark_seen' | 'typing_on' | 'typing_off',
): Promise<void> {
  try {
    await post(MESSAGES_PATH, { recipient: { id: recipientId }, sender_action: action });
  } catch {
    /* kozmetik; sessiz geç */
  }
}

// --- Yorumdan DM'e (private reply) ------------------------------------------
// Normal DM'den FARKLI bir mekanizma: yorum yapan kişiye, o hiç yazmamış olsa
// bile mesaj atmamıza izin verir (24 saat kuralını atlar). Meta'nın kuralları:
//   - yorum başına ÖMÜR BOYU tek private reply,
//   - yorumdan sonra en fazla 7 gün içinde,
//   - sadece KENDİ gönderindeki ANA yorumlar (yoruma gelen cevaplarda çalışmaz),
//   - kişi seni takip etmiyorsa mesaj "İstekler" klasörüne düşer.
// Dönen recipient_id, o kişinin DM kimliği (IGSID) — sohbeti bununla izliyoruz.
export interface PrivateReplyResult {
  mid: string | null;
  recipientId: string | null;
}

export async function sendPrivateReply(
  commentId: string,
  text: string,
): Promise<PrivateReplyResult> {
  const res = await post(MESSAGES_PATH, {
    recipient: { comment_id: commentId },
    message: { text: text.slice(0, TEXT_LIMIT) },
  });
  return {
    mid: (res.message_id as string) ?? null,
    recipientId: (res.recipient_id as string) ?? null,
  };
}

// Yorumun altına herkesin göreceği kısa cevap ("dm attım" gibi).
export async function replyToComment(commentId: string, text: string): Promise<void> {
  await post(`/${commentId}/replies`, { message: text.slice(0, TEXT_LIMIT) });
}

export interface FetchedImage {
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string; // base64
}

// Müşterinin gönderdiği fotoğrafı indirir (Claude'a göstermek için).
// Meta'nın verdiği CDN linki 24 saat sonra ölüyor; bu yüzden mesaj gelir
// gelmez indiriyoruz. Kalıcı arşivlemiyoruz (KVKK + Meta politikası).
export async function fetchAttachment(url: string): Promise<FetchedImage | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ATTACHMENT_BYTES) return null;
    return { media_type: type as FetchedImage['media_type'], data: buf.toString('base64') };
  } catch {
    return null;
  }
}

// --- Gelen webhook gövdesini sadeleştirme -----------------------------------

export interface IncomingMessage {
  senderId: string; // müşterinin Instagram-scoped ID'si
  recipientId: string; // bizim hesap
  mid: string | null;
  text: string;
  imageUrls: string[];
  isEcho: boolean; // bizim hesabın gönderdiği mesaj (API'den ya da telefondan)
  timestamp: number | null;
}

// Meta gövdesi: { object: "instagram", entry: [{ messaging: [ ... ] }] }
// İlgilenmediğimiz olaylar (okundu bilgisi, reaksiyon, postback) atlanır.
export function parseWebhook(body: any): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  for (const entry of body?.entry ?? []) {
    const events = entry?.messaging ?? entry?.standby ?? [];
    for (const ev of events) {
      const m = ev?.message;
      if (!m) continue;
      const attachments = Array.isArray(m.attachments) ? m.attachments : [];
      const imageUrls = attachments
        .filter((a: any) => a?.type === 'image' && a?.payload?.url)
        .map((a: any) => String(a.payload.url));
      const otherTypes = attachments
        .filter((a: any) => a?.type && a.type !== 'image')
        .map((a: any) => String(a.type));
      let text = typeof m.text === 'string' ? m.text.trim() : '';
      // Ses/video/dosya gönderdiyse en azından ne olduğunu ikize bildirelim.
      for (const t of otherTypes) text = (text ? text + '\n' : '') + `[${t} eki]`;
      out.push({
        senderId: String(ev?.sender?.id ?? ''),
        recipientId: String(ev?.recipient?.id ?? ''),
        mid: m.mid ? String(m.mid) : null,
        text,
        imageUrls,
        isEcho: !!m.is_echo,
        timestamp: typeof ev?.timestamp === 'number' ? ev.timestamp : null,
      });
    }
  }
  return out.filter((m) => m.senderId);
}

export interface IncomingComment {
  commentId: string;
  userId: string; // yorumu yazan
  username: string | null;
  mediaId: string | null;
  text: string;
  parentId: string | null; // dolu ise: bir yoruma gelen cevap (private reply YOK)
  isOwn: boolean; // kendi hesabımızın yorumu
}

// Yorum webhook'u mesajlardan FARKLI bir yapı kullanır:
// { entry: [{ id: <bizim hesap>, changes: [{ field: "comments", value: {...} }] }] }
export function parseCommentWebhook(body: any): IncomingComment[] {
  const out: IncomingComment[] = [];
  for (const entry of body?.entry ?? []) {
    const accountId = entry?.id ? String(entry.id) : '';
    for (const ch of entry?.changes ?? []) {
      if (ch?.field !== 'comments') continue;
      const v = ch.value ?? {};
      if (!v.id) continue;
      const userId = v?.from?.id ? String(v.from.id) : '';
      out.push({
        commentId: String(v.id),
        userId,
        username: v?.from?.username ? String(v.from.username) : null,
        mediaId: v?.media?.id ? String(v.media.id) : null,
        text: typeof v.text === 'string' ? v.text : '',
        parentId: v?.parent_id ? String(v.parent_id) : null,
        isOwn: !!userId && !!accountId && userId === accountId,
      });
    }
  }
  return out;
}
