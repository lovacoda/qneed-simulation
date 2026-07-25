// Instagram'daki mevcut DM geçmişini veritabanına aktarır.
//
// Çalıştırma:  npm run ig-import
//
// GÜVENLİK: Bu script yalnızca OKUR. Mesaj gönderen tek bir satır bile yok.
// Aktarılan sohbetler KİLİTLİ gelir (unlocked=false) — ikiz onlara kendiliğinden
// yazmaz; ancak kişi bugünden sonra yazıp tetikleyici kelimeyi söylerse açılır,
// o zaman da bu geçmişi bilerek devam eder.
import {
  IG_ACCESS_TOKEN,
  IG_ACCOUNT_ID,
  IG_GRAPH_HOST,
  IG_GRAPH_VERSION,
} from './config';
import { getSupabase } from './supabase';
import { getOrCreateThread } from './ig-store';

// Kaç sohbet ve sohbet başına kaç mesaj çekilecek (Meta daha fazlasını
// vermeyebilir; verdiği kadarını alırız).
const MAX_CONVERSATIONS = Number(process.env.IMPORT_MAX_CONVERSATIONS ?? 1000);
const MAX_MESSAGES = Number(process.env.IMPORT_MAX_MESSAGES ?? 500);

// Meta saatlik istek kotası koyuyor. Kotaya takılınca döngüyü kırıp temiz
// bitiriyoruz; bir süre sonra tekrar çalıştırınca kaldığı yerden devam eder.
class KotaHatasi extends Error {}

const log = (s: string) => console.log(s);

async function get(path: string): Promise<Record<string, any>> {
  const url = path.startsWith('http')
    ? path
    : `https://${IG_GRAPH_HOST}/${IG_GRAPH_VERSION}${path}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${IG_ACCESS_TOKEN}` } });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* aşağıda ham metni raporlarız */
  }
  if (!res.ok) {
    const mesaj = json?.error?.message ?? text.slice(0, 200);
    if (/request limit reached|rate limit/i.test(String(mesaj))) throw new KotaHatasi(mesaj);
    throw new Error(`Instagram API ${res.status}: ${mesaj}`);
  }
  return json;
}

interface Participant {
  id: string;
  username?: string;
}

// Sayfalı listeyi sonuna kadar (ya da sınıra kadar) gezer.
async function pagedList(firstPath: string, max: number): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = firstPath;
  while (next && out.length < max) {
    const page: Record<string, any> = await get(next);
    for (const item of page.data ?? []) {
      out.push(item);
      if (out.length >= max) break;
    }
    next = page.paging?.next ?? null;
  }
  return out;
}

async function main(): Promise<void> {
  if (!IG_ACCESS_TOKEN) throw new Error('IG_ACCESS_TOKEN yok — .env dosyasına bak.');
  const supabase = getSupabase();

  // Kendi hesabımızın kimliği: mesajın bize mi ait olduğunu bundan anlıyoruz.
  const me = await get(`/${IG_ACCOUNT_ID}?fields=user_id,username`);
  const myId = String(me.user_id ?? me.id ?? '');
  log(`Hesap: @${me.username} (${myId})\n`);

  const conversations = await pagedList(
    `/${IG_ACCOUNT_ID}/conversations?platform=instagram&fields=participants,updated_time&limit=50`,
    MAX_CONVERSATIONS,
  );
  log(`${conversations.length} sohbet bulundu.\n`);

  // Daha önce aldıklarımız: son mesaj tarihi değişmemişse tekrar çekmiyoruz
  // (Meta kotasını boşa harcamayalım, tekrar çalıştırmak ucuz olsun).
  const { data: mevcut } = await supabase.from('ig_threads').select('ig_user_id,last_message_at');
  const sonKayit = new Map<string, number>(
    (mevcut ?? []).map((t: Record<string, any>) => [
      String(t.ig_user_id),
      t.last_message_at ? new Date(t.last_message_at).getTime() : 0,
    ]),
  );

  let yeniMesaj = 0;
  let atlanan = 0;
  let degismeyen = 0;
  let kotaBitti = false;

  for (const conv of conversations) {
    const parts: Participant[] = conv?.participants?.data ?? [];
    const other = parts.find((p) => String(p.id) !== myId);
    if (!other) {
      atlanan++;
      continue;
    }
    const kim = other.username ? '@' + other.username : other.id;

    // Bu sohbette yeni mesaj yoksa hiç istek atma.
    const guncelleme = conv?.updated_time ? new Date(conv.updated_time).getTime() : 0;
    const bizdeki = sonKayit.get(String(other.id));
    if (bizdeki !== undefined && guncelleme && bizdeki >= guncelleme - 60_000) {
      degismeyen++;
      continue;
    }

    let messages: any[] = [];
    try {
      const detay = await get(`/${conv.id}?fields=messages.limit(50){id,created_time,from,message}`);
      messages = detay?.messages?.data ?? [];
      let next = detay?.messages?.paging?.next ?? null;
      while (next && messages.length < MAX_MESSAGES) {
        const page = await get(next);
        messages.push(...(page.data ?? []));
        next = page.paging?.next ?? null;
      }
    } catch (e) {
      if (e instanceof KotaHatasi) {
        kotaBitti = true;
        break;
      }
      log(`  ${kim}: mesajlar alınamadı (${e instanceof Error ? e.message : e})`);
      continue;
    }

    // Meta yeniden eskiye veriyor; biz eskiden yeniye yazıyoruz.
    messages.reverse();

    const thread = await getOrCreateThread(supabase, other.id);
    if (other.username && thread.username !== other.username) {
      await supabase.from('ig_threads').update({ username: other.username }).eq('id', thread.id);
    }

    const rows = messages
      .filter((m) => typeof m.message === 'string' && m.message.trim())
      .map((m) => ({
        thread_id: thread.id,
        mid: String(m.id),
        // Bizim hesabımızdan çıkanlar 'human' (satıcı), diğerleri müşteri.
        role: String(m.from?.id ?? '') === myId ? 'human' : 'customer',
        text: String(m.message).trim(),
        created_at: m.created_time ?? null,
      }));

    if (rows.length === 0) {
      log(`  ${kim}: metin mesajı yok, atlandı`);
      continue;
    }

    // mid benzersiz: daha önce yazılmış mesajlar sessizce atlanır.
    const { data, error } = await supabase
      .from('ig_messages')
      .upsert(rows, { onConflict: 'mid', ignoreDuplicates: true })
      .select('id');
    if (error) {
      log(`  ${kim}: yazılamadı — ${error.message}`);
      continue;
    }

    const eklenen = data?.length ?? 0;
    yeniMesaj += eklenen;

    // Sohbetin son mesaj zamanını gerçek tarihe çek (sıralama doğru olsun).
    const sonTarih = rows[rows.length - 1].created_at;
    if (sonTarih) {
      await supabase.from('ig_threads').update({ last_message_at: sonTarih }).eq('id', thread.id);
    }

    log(`  ${kim}: ${rows.length} mesaj (${eklenen} yeni)`);
  }

  log(`\nBitti. ${yeniMesaj} yeni mesaj kaydedildi.`);
  if (degismeyen) log(`${degismeyen} sohbet değişmemişti, atlandı.`);
  if (atlanan) log(`${atlanan} sohbet atlandı (karşı taraf okunamadı).`);
  if (kotaBitti) {
    log('\n⚠  Meta saatlik istek kotası doldu — kalanlar alınamadı.');
    log('   Bir saat sonra "npm run ig-import" komutunu tekrar çalıştır,');
    log('   kaldığı yerden devam eder (alınanları tekrar çekmez).');
  }
  log('Aktarılan sohbetler KİLİTLİ — ikiz kendiliğinden yazmaz.');
}

main().catch((e) => {
  console.error('\nHata:', e?.message ?? e);
  process.exit(1);
});
