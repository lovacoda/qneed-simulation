// Instagram DM webhook sunucusu: Meta'dan gelen mesajı alır, beyne sorar,
// cevabı DM olarak geri gönderir.
//
// Çalıştırma:  npm run instagram
// Meta'nın erişebilmesi için bu sunucunun public HTTPS bir adresi olmalı
// (cloudflared / ngrok tüneli — README'ye bak).
import http from 'node:http';
import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropic, buildSystemPrompt } from './brain';
import { getSupabase } from './supabase';
import {
  MODEL,
  ANTHROPIC_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  IG_ACCESS_TOKEN,
  IG_APP_SECRET,
  IG_VERIFY_TOKEN,
  IG_AUTO_REPLY,
  IG_HISTORY_LIMIT,
  IG_WAIT_MIN_SEC,
  IG_WAIT_MAX_SEC,
  IG_WAIT_CEILING_SEC,
  IG_TYPING_MIN_SEC,
  IG_TYPING_MAX_SEC,
  TELEGRAM_CHAT_ID,
  WEBHOOK_PORT,
} from './config';
import {
  parseWebhook,
  parseCommentWebhook,
  verifySignature,
  sendText,
  sendImage,
  sendAction,
  sendPrivateReply,
  replyToComment,
  fetchAttachment,
  fetchUsername,
  medyaNotu,
  type IncomingMessage,
  type IncomingComment,
} from './instagram';
import {
  getOrCreateThread,
  findThread,
  threadById,
  latestThread,
  listThreads,
  recordMessage,
  isKnownMid,
  loadHistory,
  setAutoReply,
  unlockThread,
  threadIsMuted,
  claimComment,
  markComment,
  linkTelegramMessage,
  threadByTelegramMessage,
  type IgTurn,
  type IgThread,
} from './ig-store';
import {
  telegramEnabled,
  notify,
  notifyPhoto,
  ackCallback,
  swapButtons,
  startPolling,
  type TgEvent,
} from './telegram';
import { listTriggers, pickTrigger, type Trigger } from './triggers';
import { getProductBySlug } from './store';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const now = () => new Date().toLocaleTimeString('tr-TR');
const log = (s: string) => console.log(`[${now()}] ${s}`);

// Kanala özel ek talimat. Ana talimatlar (data/prompt.md) dokunulmadan kalır.
const CHANNEL_NOTE = `### KANAL — INSTAGRAM DM
- Bu sohbet Instagram DM üzerinden geçiyor. Kısa ve mesajlaşma diliyle yaz.
- Uzun tek blok yazma. Ayrı mesaj olarak gitmesini istediğin yeri boş satırla ayır.
- Müşteri fotoğraf gönderirse görebiliyorsun. Fotoğrafa bakıp teşhis/hastalık yorumu YAPMA;
  sadece kozmetik gözlem yap ve katalogdan uygun ürüne bağla.

ÜRÜN GÖRSELİ GÖNDERME (önemli):
Bir ürün önerdiğinde, katalogda o ürünün yanında [kod: ...] varsa görsellerini de gönder:
- Cevabında doğal bir şekilde görsel göndereceğini söyle (kendi tarzınla, ör. "birkaç görsel atayım").
- Cevabının EN SONUNA, ayrı bir satıra tam olarak şunu yaz: [foto: kod]
- "kod" katalogdaki o ürünün kodudur. Tek ürün için bir kez yaz.
- Bu satırı müşteri görmez, sistem onu alıp görselleri gönderir. Başka yere yazma,
  cümlenin içine karıştırma. Ürün önermediğin mesajlarda hiç yazma.`;

// --- Mesaj işleme -----------------------------------------------------------

// Aynı müşteriden arka arkaya gelen mesajlar sırayla işlensin (araya girmesin).
const queues = new Map<string, Promise<void>>();
function enqueue(key: string, fn: () => Promise<void>): void {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn).catch((e) => log(`HATA (${key}): ${errMsg(e)}`));
  queues.set(key, next);
  void next.then(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
}

// Geçmişi Claude'un beklediği role dizisine çevirir. 'human' (senin telefondan
// yazdığın) satırlar da ikizin ağzı sayılır — tarz zaten senin tarzın.
function toAnthropicMessages(history: IgTurn[]): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = [];
  for (const t of history) {
    if (!t.text?.trim()) continue;
    msgs.push({ role: t.role === 'customer' ? 'user' : 'assistant', content: t.text });
  }
  // İlk mesaj 'user' olmalı; baştaki ikiz mesajlarını at.
  while (msgs.length && msgs[0].role === 'assistant') msgs.shift();
  return msgs;
}

// İkizin cevabındaki "[foto: kod]" işaretini ayıklar. Müşteri bu satırı görmez.
const FOTO_ISARETI = /\[\s*foto\s*:\s*([^\]]+?)\s*\]/gi;
function ayiklaFotoKodu(text: string): { temiz: string; slug: string | null } {
  let slug: string | null = null;
  const temiz = text
    .replace(FOTO_ISARETI, (_, kod: string) => {
      if (!slug) slug = kod.trim();
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { temiz, slug };
}

// Ürünün görsellerini sırayla gönderir (her biri ayrı mesaj).
const MAX_URUN_FOTO = 4;
async function sendProductPhotos(
  supabase: ReturnType<typeof getSupabase>,
  threadId: string,
  recipientId: string,
  slug: string,
): Promise<void> {
  const p = await getProductBySlug(supabase, slug);
  if (!p) return log(`   (foto: "${slug}" diye ürün yok)`);
  const urls: string[] = (
    Array.isArray(p.image_urls) && p.image_urls.length ? p.image_urls : [p.image_url]
  ).filter((u: unknown): u is string => typeof u === 'string' && !!u);
  if (!urls.length) return log(`   (${p.name}: görsel yok)`);

  for (const url of urls.slice(0, MAX_URUN_FOTO)) {
    try {
      const img = await sendImage(recipientId, url);
      await recordMessage(supabase, {
        thread_id: threadId,
        mid: img.mid,
        role: 'assistant',
        text: `[fotoğraf: ${p.name}]`,
        image_url: url,
      });
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      log(`   (görsel gönderilemedi: ${errMsg(e)})`);
      break;
    }
  }
  log(`   📸 ${p.name}: ${Math.min(urls.length, MAX_URUN_FOTO)} görsel gönderildi`);
}

// Giden mesajı gönderip kaydeder (kendi echo'muzu tanıyabilmek için mid şart).
async function sendAndRecord(
  supabase: ReturnType<typeof getSupabase>,
  threadId: string,
  recipientId: string,
  text: string,
): Promise<void> {
  for (const s of await sendText(recipientId, text)) {
    await recordMessage(supabase, { thread_id: threadId, mid: s.mid, role: 'assistant', text: s.text });
  }
}

// DM'e yazılan tetikleyici kelime. true dönerse ikiz devreye girmez.
async function applyDmTrigger(
  supabase: ReturnType<typeof getSupabase>,
  threadId: string,
  recipientId: string,
  t: Trigger,
): Promise<boolean> {
  const text = t.dm_text?.trim() ?? '';

  if (t.action === 'reply') {
    if (!text) return false; // metin yoksa ikize bırak
    await sendAndRecord(supabase, threadId, recipientId, text);
    log(`→ hazır mesaj ("${t.keyword}") gönderildi`);
    return true;
  }

  if (t.action === 'product') {
    if (!t.product_slug) return false;
    if (text) await sendAndRecord(supabase, threadId, recipientId, text);
    await sendProductPhotos(supabase, threadId, recipientId, t.product_slug);
    return true;
  }

  if (t.action === 'handover') {
    if (text) await sendAndRecord(supabase, threadId, recipientId, text);
    await setPause(supabase, threadId, true);
    log(`✋ "${t.keyword}" → sohbet sana devredildi (ikiz /resume'a kadar susuyor)`);
    const th = await threadById(supabase, threadId);
    if (th) {
      await tgSafe(async () => {
        const n = await notify(
          `✋ ${who(th)} → "${t.keyword}" tetikleyicisi: ikiz durdu, sohbet sende.\nBitince ▶️ Devam et'e bas.`,
          { threadId, paused: true },
        );
        if (n.messageId) await linkTelegramMessage(supabase, n.messageId, threadId);
      });
    }
    return true;
  }

  return false; // 'ai' → normal akış
}

// --- Telegram kumandası -----------------------------------------------------

const who = (t: IgThread): string => (t.username ? '@' + t.username : t.ig_user_id);

// Telegram'daki bir aksaklık Instagram akışını bozmasın.
async function tgSafe(fn: () => Promise<unknown>): Promise<void> {
  if (!telegramEnabled()) return;
  try {
    await fn();
  } catch (e) {
    log(`Telegram: ${errMsg(e)}`);
  }
}

// Müşterinin fotoğrafını Telegram'a iletir. Meta linki 24 saatte öldüğü için
// Telegram indiremezse elimizdeki baytları yüklüyoruz (telegram.ts hallediyor).
async function forwardPhotos(
  supabase: ReturnType<typeof getSupabase>,
  thread: IgThread,
  msg: IncomingMessage,
): Promise<void> {
  const caption =
    `📷 ${who(thread)} fotoğraf gönderdi — ikiz durdu.\n` +
    (msg.text ? `"${msg.text}"\n` : '') +
    'Konuşmayı bitirince aşağıdaki ▶️ Devam et düğmesine bas.';

  // Kaybolan fotoğraf/video gibi indirilemeyen eklerde URL gelmiyor — en
  // azından haber verelim, düğme yine altında olsun.
  if (msg.imageUrls.length === 0) {
    const n = await notify(caption, { threadId: thread.id, paused: true });
    if (n.messageId) await linkTelegramMessage(supabase, n.messageId, thread.id);
    return;
  }

  for (const [i, url] of msg.imageUrls.slice(0, 4).entries()) {
    const img = await fetchAttachment(url);
    const n = await notifyPhoto(url, i === 0 ? caption : '', {
      threadId: thread.id,
      paused: true,
      bytes: img ? Buffer.from(img.data, 'base64') : undefined,
      mediaType: img?.media_type,
    });
    if (n.messageId) await linkTelegramMessage(supabase, n.messageId, thread.id);
  }
}

async function setPause(
  supabase: ReturnType<typeof getSupabase>,
  threadId: string,
  paused: boolean,
): Promise<void> {
  await setAutoReply(supabase, threadId, !paused);
  if (paused) cancelPending(threadId); // bekleyen hazır cevabı da iptal et
}

// /resume: ikiz devreye girer ama HEMEN yazmaz — müşteriden yeni mesaj
// gelmesini bekler. Yazdığında duraklama boyunca birikenlerin tamamını
// (senin Instagram'dan yazdıklarınla birlikte) okuyup öyle cevaplar.
async function resumeThread(
  supabase: ReturnType<typeof getSupabase>,
  thread: IgThread,
): Promise<void> {
  await setPause(supabase, thread.id, false);
}

const TG_HELP = `qneed kumanda 🎛

/pause — o sohbette ikizi durdurur (bekleyen cevabı da iptal eder)
/resume — ikiz sohbetin tamamını okuyup kaldığı yerden devam eder
/durum — açık sohbetler ve durumları

Hangi müşteri olduğunu belirtmek için bildirime *kaydırıp yanıtla* ya da
altındaki düğmeyi kullan. Düz yazarsan en son mesaj gelen müşteriye uygulanır.`;

// Komut hangi müşteriye ait: kaydırıp yanıtladıysa o, yoksa en son yazan.
async function targetThread(
  supabase: ReturnType<typeof getSupabase>,
  replyTo: number | null,
): Promise<IgThread | null> {
  if (replyTo) {
    const t = await threadByTelegramMessage(supabase, replyTo);
    if (t) return t;
  }
  return latestThread(supabase);
}

async function handleTelegram(e: TgEvent): Promise<void> {
  const supabase = getSupabase();

  if (e.kind === 'button') {
    const [op, threadId] = e.data.split(':');
    if (!threadId) return;
    const paused = op === 'p';
    const thread = await threadById(supabase, threadId);
    if (!thread) return ackCallback(e.callbackId, 'Sohbet bulunamadı');
    if (paused) {
      await setPause(supabase, threadId, true);
      log(`⏸ Telegram: ${who(thread)} durduruldu`);
    } else {
      await resumeThread(supabase, thread);
      log(`▶️ Telegram: ${who(thread)} devam ediyor`);
    }
    await ackCallback(e.callbackId, paused ? 'İkiz durdu' : 'İkiz devam ediyor');
    if (e.messageId) await swapButtons(e.messageId, threadId, paused);
    return;
  }

  const cmd = e.text.replace(/@\S+/g, '').trim().toLowerCase().split(/\s+/)[0].replace(/^\//, '');

  if (['pause', 'dur', 'durdur', 'stop'].includes(cmd)) {
    const thread = await targetThread(supabase, e.replyToMessageId);
    if (!thread) return void (await notify('Durduracak sohbet bulamadım.'));
    await setPause(supabase, thread.id, true);
    log(`⏸ Telegram: ${who(thread)} durduruldu`);
    await notify(`⏸ ${who(thread)} → ikiz durdu. Devam için /resume.`, {
      threadId: thread.id,
      paused: true,
    });
    return;
  }

  if (['resume', 'devam', 'ac', 'aç', 'start'].includes(cmd)) {
    const thread = await targetThread(supabase, e.replyToMessageId);
    if (!thread) return void (await notify('Devam ettirecek sohbet bulamadım.'));
    await resumeThread(supabase, thread);
    log(`▶️ Telegram: ${who(thread)} devam ediyor`);
    await notify(
      `▶️ ${who(thread)} → ikiz devam ediyor.\nMüşteri yeni mesaj yazınca cevaplayacak.`,
      { threadId: thread.id, paused: false },
    );
    return;
  }

  if (['durum', 'status', 'liste'].includes(cmd)) {
    const list = await listThreads(supabase);
    const rows = list.slice(0, 15).map((t: any) => {
      const bekleyen = pending.has(t.id) ? ' ⏳' : '';
      return `${t.auto_reply ? '▶️' : '⏸'} ${t.username ? '@' + t.username : t.ig_user_id}${bekleyen}`;
    });
    await notify(rows.length ? 'Sohbetler:\n' + rows.join('\n') : 'Henüz sohbet yok.');
    return;
  }

  await notify(TG_HELP);
}

// --- Mesaj biriktirme -------------------------------------------------------
// Müşteri genelde alt alta birkaç mesaj atar. Her birine ayrı cevap yazmak
// robot işi; onun yerine susmasını bekleyip hepsini birden okuyup TEK cevap
// yazıyoruz. Yeni mesaj gelirse süre baştan başlar (tavan sınırı var).

interface Pending {
  timer: NodeJS.Timeout;
  firstAt: number; // ilk mesajın zamanı — tavanı buradan sayıyoruz
  senderId: string;
}
const pending = new Map<string, Pending>();

const rndMs = (minSec: number, maxSec: number): number =>
  Math.round((minSec + Math.random() * Math.max(0, maxSec - minSec)) * 1000);

// Bekleyen cevabı iptal eder. /pause'un "hafızayı sıfırla" dediği şey bu.
function cancelPending(threadId: string): boolean {
  const p = pending.get(threadId);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(threadId);
  return true;
}

function schedulePending(threadId: string, senderId: string): void {
  const existing = pending.get(threadId);
  const firstAt = existing?.firstAt ?? Date.now();
  if (existing) clearTimeout(existing.timer);

  let wait = rndMs(IG_WAIT_MIN_SEC, IG_WAIT_MAX_SEC);
  // Müşteri hiç susmazsa sonsuza kadar bekleme: ilk mesajdan itibaren tavan.
  const left = IG_WAIT_CEILING_SEC * 1000 - (Date.now() - firstAt);
  if (wait > left) wait = Math.max(0, left);

  const timer = setTimeout(() => {
    pending.delete(threadId);
    // Yığın bu pencerede gelenlerle sınırlı (biraz pay bırakıyoruz).
    enqueue(senderId, () => replyNow(threadId, senderId, firstAt - 10_000));
  }, wait);
  pending.set(threadId, { timer, firstAt, senderId });
  log(`   ⏳ ${Math.round(wait / 1000)} sn bekleniyor (yeni mesaj gelirse uzar)`);
}

// Bu turda cevaplanacak yığın: sohbetin sonundaki ardışık müşteri mesajları.
// `since` verilirse yalnızca bekleme penceresinde gelenler sayılır — geçmişten
// içeri aktarılmış eski mesajlar "yeni gelmiş" gibi işlenmesin diye.
function tailCustomerTurns(history: IgTurn[], since?: number): IgTurn[] {
  const out: IgTurn[] = [];
  for (let i = history.length - 1; i >= 0 && history[i].role === 'customer'; i--) {
    const t = history[i];
    if (since && t.created_at && new Date(t.created_at).getTime() < since) break;
    out.unshift(t);
  }
  return out;
}

// Bekleme bitti: geçmişin tamamını oku, tek cevap yaz, gönder.
async function replyNow(threadId: string, senderId: string, since?: number): Promise<void> {
  const supabase = getSupabase();
  const thread = await threadById(supabase, threadId);
  if (!thread) return;
  // Beklerken durdurulmuş olabilir (fotoğraf geldi, /pause yazıldı, sen yazdın).
  if (threadIsMuted(thread)) return log('   (bekleyen cevap iptal — ikiz durdurulmuş)');

  const history = await loadHistory(supabase, threadId, IG_HISTORY_LIMIT);
  const batch = tailCustomerTurns(history, since);
  const batchText = batch.map((t) => t.text).join('\n').trim();
  if (!batchText) return;

  // Tetikleyici kelimeler yığının tamamında aranır.
  const dmTrigger = pickTrigger(await listTriggers(supabase), batchText, null, 'dm');
  if (dmTrigger) {
    await sendAction(senderId, 'mark_seen');
    if (await applyDmTrigger(supabase, threadId, senderId, dmTrigger)) return;
  }

  const messages = toAnthropicMessages(history);
  if (messages.length === 0) return;

  // Yığındaki fotoğrafları son kullanıcı mesajına iliştir (Claude görsün).
  const urls = batch.map((t) => t.image_url).filter((u): u is string => !!u).slice(0, 4);
  if (urls.length) {
    const images = (await Promise.all(urls.map(fetchAttachment))).filter(
      (i): i is NonNullable<typeof i> => !!i,
    );
    if (images.length) {
      const last = messages[messages.length - 1];
      const text = typeof last.content === 'string' ? last.content : batchText;
      last.content = [
        ...images.map((img) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: img.media_type, data: img.data },
        })),
        { type: 'text' as const, text },
      ];
    }
  }

  // Geçmişte fotoğraf var ama şu an göremiyorsak (satıcı devralıp cevapladı,
  // ya da fotoğraf bu turun dışında kaldı) ikizin o fotoğraf hakkında
  // konuşmasını engelliyoruz — göremediği şeyi uydurmasın.
  const gorunenFoto = urls.length > 0;
  const gecmisteFoto = history.some(
    (h) => h.image_url || /fotoğraf gönderdi|fotoğraf:/i.test(h.text),
  );
  const note =
    !gorunenFoto && gecmisteFoto
      ? `${CHANNEL_NOTE}

### GEÇMİŞTEKİ FOTOĞRAF (dikkat)
Bu sohbette daha önce müşteri fotoğraf gönderdi ve onu satıcı inceleyip cevapladı.
O fotoğrafı ŞU AN GÖREMİYORSUN. Fotoğraf hakkında yeni bir değerlendirme yapma,
"fotoğrafta şunu görüyorum" gibi bir şey YAZMA, görmediğin bir detayı uydurma.
Konuşmayı kaldığı yerden sürdür; fotoğrafla ilgili söylenmesi gereken zaten
söylendi. Gerekirse müşterinin yazdıklarına dayan.`
      : CHANNEL_NOTE;

  const system = await buildSystemPrompt(batchText, note);
  const anthropic = getAnthropic();
  const reply = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system,
    messages,
  });

  const ham = reply.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  // Ürün görseli işaretini metinden ayır.
  const { temiz: text, slug: fotoSlug } = ayiklaFotoKodu(ham);
  if (!text) return log('   (ikiz boş cevap üretti — gönderilmedi)');

  // Gerçekçilik: cevap uzunluğuna göre "yazıyor..." süresi.
  const span = IG_TYPING_MAX_SEC - IG_TYPING_MIN_SEC;
  const typingSec = Math.min(
    IG_TYPING_MAX_SEC,
    IG_TYPING_MIN_SEC + (text.length / 400) * Math.max(0, span),
  );
  await sendAction(senderId, 'mark_seen');
  await sendAction(senderId, 'typing_on');
  await new Promise((r) => setTimeout(r, typingSec * 1000));

  // Yazarken durdurulmuş olabilir — son bir kontrol.
  const fresh = await threadById(supabase, threadId);
  if (fresh && threadIsMuted(fresh)) return log('   (cevap gönderilmedi — bu arada durduruldu)');

  await sendAction(senderId, 'typing_off');
  for (const s of await sendText(senderId, text)) {
    await recordMessage(supabase, {
      thread_id: threadId,
      mid: s.mid,
      role: 'assistant',
      text: s.text,
    });
  }
  log(`→ ${senderId}: ${text.slice(0, 80)}`);

  // Ürün önerdiyse görselleri arkasından gönder.
  if (fotoSlug) await sendProductPhotos(supabase, threadId, senderId, fotoSlug);
}

// --- Gelen müşteri mesajı ---------------------------------------------------

async function handleCustomerMessage(msg: IncomingMessage): Promise<void> {
  const supabase = getSupabase();
  let thread = await getOrCreateThread(supabase, msg.senderId);

  // Telegram bildiriminde numara yerine @kullanıcıadı görünsün diye bir kez çek.
  if (!thread.username) {
    const u = await fetchUsername(msg.senderId);
    if (u) {
      await supabase.from('ig_threads').update({ username: u }).eq('id', thread.id);
      thread = { ...thread, username: u };
    }
  }

  const marks = msg.imageUrls.length ? medyaNotu('image', msg.imageUrls.length) : '';
  const storedText = [msg.text, marks].filter(Boolean).join(' ').trim() || '(boş mesaj)';

  const fresh = await recordMessage(supabase, {
    thread_id: thread.id,
    mid: msg.mid,
    role: 'customer',
    text: storedText,
    image_url: msg.imageUrls[0] ?? null,
  });
  if (!fresh) return; // Meta aynı webhook'u tekrar göndermiş

  log(`← ${msg.senderId}: ${storedText.slice(0, 80)}`);

  // Sohbet zaten durdurulmuşsa Telegram'a hiçbir şey gönderme — sen o sırada
  // Instagram'dan konuşuyorsun, tek "Devam et" düğmesi yeterli. Mesajlar yine
  // kaydediliyor; devam edince ikiz hepsini okuyacak.
  if (threadIsMuted(thread)) {
    return log('   (ikiz durdurulmuş — kaydedildi, Telegram\'a iletilmedi)');
  }

  // Normal mesajlar Telegram'a gitmiyor: sadece ikizin durduğu anlar bildiriliyor.
  if (!IG_AUTO_REPLY) return log('   (otomatik cevap kapalı — IG_AUTO_REPLY=false)');

  // Tetikleyici kelime gelmemiş sohbetler bizim için yok hükmünde: ikiz yazmaz,
  // fotoğrafları da Telegram'a iletilmez. Kelime gelince sohbet açılır.
  if (!thread.unlocked) {
    const t = pickTrigger(await listTriggers(supabase), msg.text, null, 'dm');
    if (!t) return log('   (tetikleyici kelime yok — sohbet kilitli, karışmıyoruz)');
    await unlockThread(supabase, thread.id);
    log(`   🔓 "${t.keyword}" geldi — sohbet ikize açıldı`);
  }

  // Açık sohbette medya geldiyse: Telegram'a ilet, ikizi durdur, cevap yazma.
  if (msg.hasMedia) {
    cancelPending(thread.id);
    await setAutoReply(supabase, thread.id, false);
    await tgSafe(() => forwardPhotos(supabase, thread, msg));
    log('   📷 medya → Telegram, ikiz durduruldu');
    return;
  }

  schedulePending(thread.id, msg.senderId);
}

// Kendi hesabımızdan çıkan mesajın kopyası. İki ihtimal var:
//  - biz API'den gönderdik → mid zaten kayıtlı, yapacak bir şey yok.
//  - SEN Instagram'dan yazdın → sohbeti devraldın; ikiz /resume'a kadar susar.
async function handleEcho(msg: IncomingMessage): Promise<void> {
  const supabase = getSupabase();
  if (msg.mid && (await isKnownMid(supabase, msg.mid))) return;

  const customerId = msg.recipientId;
  if (!customerId) return;
  const thread = await getOrCreateThread(supabase, customerId);
  await recordMessage(supabase, {
    thread_id: thread.id,
    mid: msg.mid,
    role: 'human',
    text: msg.text || medyaNotu('image'),
  });
  cancelPending(thread.id);
  const wasActive = !threadIsMuted(thread);
  await setAutoReply(supabase, thread.id, false);
  log(`✋ Sen yazdın (${customerId}) — ikiz /resume diyene kadar susuyor.`);
  if (wasActive) {
    await tgSafe(async () => {
      const n = await notify(
        `✋ ${who(thread)} sohbetini sen devraldın — ikiz durdu.\nBitince ▶️ Devam et'e bas.`,
        { threadId: thread.id, paused: true },
      );
      if (n.messageId) await linkTelegramMessage(supabase, n.messageId, thread.id);
    });
  }
}

// --- Yorumdan DM'e ----------------------------------------------------------

// Yorum tetiklemesinde DM'i BİZ başlatıyoruz; ikizin bunu bilmesi gerekiyor
// ki "merhaba, nasıl yardımcı olabilirim" gibi bir karşılama yazmasın.
function commentNote(comment: string, keyword: string): string {
  return `${CHANNEL_NOTE}

### BU MESAJI SEN BAŞLATIYORSUN
Müşteri gönderilerinden birine "${comment}" yorumunu yaptı ("${keyword}" tetikleyicisi).
Ona ilk DM'i sen atıyorsun. Kurallar:
- Yorumuna doğrudan cevap ver; genel bir karşılama/tanıtım yazma.
- ÇOK kısa tut (1-2 cümle) ve sonunda tek bir soru sor.
- Yorumu birebir tekrar etme, "yorumunu gördüm" demen yeterli.`;
}

async function generateOpener(c: IncomingComment, keyword: string): Promise<string> {
  const system = await buildSystemPrompt(c.text, commentNote(c.text, keyword));
  const anthropic = getAnthropic();
  const reply = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system,
    messages: [{ role: 'user', content: `(gönderiye yorum: "${c.text}")` }],
  });
  return reply.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

async function handleComment(c: IncomingComment): Promise<void> {
  if (c.isOwn) return; // kendi yorumumuz
  const supabase = getSupabase();

  // Yorum başına ömür boyu TEK private reply hakkımız var — tekrar gelen
  // webhook'ta ikinci kez denemeyelim.
  const fresh = await claimComment(supabase, {
    comment_id: c.commentId,
    ig_user_id: c.userId,
    username: c.username,
    media_id: c.mediaId,
    text: c.text,
  });
  if (!fresh) return;
  log(`💬 yorum @${c.username ?? c.userId}: ${c.text.slice(0, 60)}`);

  const skip = async (reason: string) => {
    await markComment(supabase, c.commentId, { skipped_reason: reason });
    log(`   (${reason})`);
  };

  if (!IG_AUTO_REPLY) return skip('otomatik cevap kapalı');
  // Meta, yoruma gelen cevaplarda private reply'a izin vermiyor.
  if (c.parentId) return skip('yoruma gelen cevap — private reply yapılamaz');

  const trigger = pickTrigger(await listTriggers(supabase), c.text, c.mediaId, 'comment');
  if (!trigger) return skip('tetikleyici kelime yok');
  await markComment(supabase, c.commentId, { matched_keyword: trigger.keyword });

  // Zaten sohbet ediyorsak hazır mesajla araya girmeyelim. (Yorumdaki kimlik
  // ile DM kimliği her zaman aynı olmayabilir; bu kontrol "en iyi çaba".)
  const existing = await findThread(supabase, c.userId);
  if (existing?.last_message_at && Date.now() - new Date(existing.last_message_at).getTime() < 86_400_000) {
    return skip('bu kişiyle zaten sohbet açık');
  }

  // Private reply'ın ilk mesajı metin olmak zorunda: hazır metin varsa o,
  // yoksa ikiz yoruma özel bir açılış yazar.
  const text = trigger.dm_text?.trim() || (await generateOpener(c, trigger.keyword));
  if (!text) return skip('mesaj üretilemedi');

  let sent;
  try {
    sent = await sendPrivateReply(c.commentId, text);
  } catch (e) {
    // 7 günü geçmiş, hak kullanılmış ya da izin eksik olabilir.
    return skip(`DM gönderilemedi: ${errMsg(e)}`);
  }

  const thread = await getOrCreateThread(supabase, sent.recipientId ?? c.userId);
  // DM'i biz başlattık; bu sohbet baştan ikize açık.
  if (!thread.unlocked) await unlockThread(supabase, thread.id);
  if (c.username && thread.username !== c.username) {
    await supabase.from('ig_threads').update({ username: c.username }).eq('id', thread.id);
  }
  await recordMessage(supabase, {
    thread_id: thread.id,
    mid: sent.mid,
    role: 'assistant',
    text,
  });
  await markComment(supabase, c.commentId, { dm_sent: true });
  log(`→ DM (yorumdan) @${c.username ?? c.userId}: ${text.slice(0, 60)}`);

  // Metinden sonraki aksiyonlar: ürün fotoğrafı ekle ya da sohbeti sana devret.
  const dmId = sent.recipientId ?? c.userId;
  if (trigger.action === 'product' && trigger.product_slug) {
    const p = await getProductBySlug(supabase, trigger.product_slug);
    if (p?.image_url) {
      try {
        const img = await sendImage(dmId, p.image_url);
        await recordMessage(supabase, {
          thread_id: thread.id,
          mid: img.mid,
          role: 'assistant',
          text: `[fotoğraf: ${p.name}]`,
          image_url: p.image_url,
        });
        log(`   → ürün fotoğrafı: ${p.name}`);
      } catch (e) {
        log(`   (ürün fotoğrafı gönderilemedi: ${errMsg(e)})`);
      }
    } else {
      log('   (seçili üründe fotoğraf yok)');
    }
  }
  if (trigger.action === 'handover') {
    await setPause(supabase, thread.id, true);
    log("   ✋ sohbet sana devredildi (ikiz /resume'a kadar susuyor)");
  }

  if (trigger.public_reply?.trim()) {
    try {
      await replyToComment(c.commentId, trigger.public_reply.trim());
    } catch (e) {
      log(`   (yorum altına cevap yazılamadı: ${errMsg(e)})`);
    }
  }
}

function processBody(body: unknown): void {
  for (const msg of parseWebhook(body)) {
    const key = msg.isEcho ? msg.recipientId : msg.senderId;
    enqueue(key, () => (msg.isEcho ? handleEcho(msg) : handleCustomerMessage(msg)));
  }
  for (const c of parseCommentWebhook(body)) {
    enqueue(c.userId || c.commentId, () => handleComment(c));
  }
}

// --- HTTP sunucusu ----------------------------------------------------------

function readRaw(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('gövde çok büyük'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Kontrol paneli artık ana arayüzde (npm run ui > Instagram sekmesi).
// Burada sadece "ayakta mıyım" bilgisi ve oraya yönlendiren küçük bir sayfa var.
function healthJson(): string {
  return JSON.stringify({
    ok: true,
    autoReply: IG_AUTO_REPLY,
    hasToken: !!IG_ACCESS_TOKEN,
    hasSecret: !!IG_APP_SECRET,
    hasVerifyToken: !!IG_VERIFY_TOKEN,
    telegram: telegramEnabled() && !!TELEGRAM_CHAT_ID,
    waitSec: [IG_WAIT_MIN_SEC, IG_WAIT_MAX_SEC],
    port: WEBHOOK_PORT,
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${WEBHOOK_PORT}`);
  const p = url.pathname;
  const method = req.method ?? 'GET';

  try {
    // 1) Meta'nın webhook doğrulaması (Callback URL kaydederken bir kez).
    if (method === 'GET' && (p === '/webhook' || p === '/')) {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && challenge) {
        if (!IG_VERIFY_TOKEN || token !== IG_VERIFY_TOKEN) {
          log('Webhook doğrulaması BAŞARISIZ — hub.verify_token eşleşmedi.');
          res.writeHead(403).end('forbidden');
          return;
        }
        log('Webhook doğrulandı ✔');
        res.writeHead(200, { 'content-type': 'text/plain' }).end(challenge);
        return;
      }
    }

    // 2) Gelen mesajlar.
    if (method === 'POST' && (p === '/webhook' || p === '/')) {
      const raw = await readRaw(req);
      if (!verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined)) {
        log(
          IG_APP_SECRET
            ? 'İmza doğrulanamadı — istek reddedildi.'
            : 'IG_APP_SECRET .env içinde yok — istek reddedildi (imza doğrulanamıyor).',
        );
        res.writeHead(403).end('forbidden');
        return;
      }
      // Meta hızlı 200 bekler; işlemeyi arka planda yapıyoruz.
      res.writeHead(200).end('EVENT_RECEIVED');
      try {
        processBody(JSON.parse(raw.toString('utf8')));
      } catch (e) {
        log(`Gövde işlenemedi: ${errMsg(e)}`);
      }
      return;
    }

    // 3) Sağlık bilgisi — ana arayüz (3939) bunu okuyup "çalışıyor" diyor.
    // Farklı port olduğu için CORS başlığı gerekiyor.
    if (method === 'GET' && p === '/health') {
      res
        .writeHead(200, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
        })
        .end(healthJson());
      return;
    }

    // 4) Eski panel adresi — artık ana arayüze yönlendiriyoruz.
    if (method === 'GET' && p === '/durum') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        `<!doctype html><meta charset="utf-8"><title>qneed — Instagram</title>
<body style="font-family:system-ui;margin:40px;max-width:560px;line-height:1.6">
<h2>Instagram sunucusu çalışıyor ✔</h2>
<p>Tetikleyici kelimeler, sohbetler ve yorumlar artık <b>ana arayüzde</b>:</p>
<p><a href="http://localhost:3939" style="font-size:18px">http://localhost:3939</a> → <b>Instagram</b> sekmesi</p>
<p style="color:#666;font-size:14px">(Arayüz açık değilse ayrı bir pencerede <code>npm run ui</code> çalıştır.)</p>`,
      );
      return;
    }

    res.writeHead(404).end('not found');
  } catch (e) {
    log(`Sunucu hatası: ${errMsg(e)}`);
    if (!res.headersSent) res.writeHead(500).end('error');
  }
});

function checkConfig(): void {
  const eksik: string[] = [];
  if (!ANTHROPIC_API_KEY) eksik.push('ANTHROPIC_API_KEY');
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) eksik.push('SUPABASE_URL / SUPABASE_SERVICE_KEY');
  if (!IG_ACCESS_TOKEN) eksik.push('IG_ACCESS_TOKEN');
  if (!IG_APP_SECRET) eksik.push('IG_APP_SECRET');
  if (!IG_VERIFY_TOKEN) eksik.push('IG_VERIFY_TOKEN');
  if (eksik.length) {
    console.log('\n⚠  .env içinde eksik olanlar: ' + eksik.join(', '));
    console.log('   (IG_* değerleri olmadan Instagram tarafı çalışmaz — README > Instagram)\n');
  }
}

// Telegram kumandasını başlatır (token varsa). Tünel gerekmiyor: bot dışarı
// doğru bağlanıp bekliyor.
function startTelegram(): void {
  if (!telegramEnabled()) {
    console.log('Telegram kumandası kapalı (TELEGRAM_BOT_TOKEN yok).');
    return;
  }
  if (!TELEGRAM_CHAT_ID) {
    console.log(
      '\n⚠  TELEGRAM_CHAT_ID yok. Botuna Telegram\'dan bir mesaj yaz;\n' +
        '   burada chat id yazacak, onu .env\'e ekleyip yeniden başlat.\n',
    );
  }
  startPolling(
    (e) => enqueue('telegram', () => handleTelegram(e)),
    (s) => log(s),
  );
  console.log(
    TELEGRAM_CHAT_ID
      ? 'Telegram kumandası açık ✔  (/pause · /resume · /durum)'
      : 'Telegram dinleniyor — chat id öğrenmek için bota yaz.',
  );
}

server.listen(WEBHOOK_PORT, () => {
  console.log(`\nqneed Instagram webhook dinliyor: http://localhost:${WEBHOOK_PORT}/webhook`);
  console.log(`Kontrol paneli: http://localhost:3939 → Instagram sekmesi`);
  console.log('Meta panosuna vereceğin adres: <tünel-adresin>/webhook');
  startTelegram();
  checkConfig();
  console.log('(Kapatmak için Ctrl+C)\n');
});
