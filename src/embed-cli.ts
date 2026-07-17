// Mevcut tüm konuşmaların anlam parmak izini (embedding) toplu üretir/tazeler.
// Kullanım: npm run embed
// Yeni eklenen konuşmalar zaten otomatik gömülür; bu komut geriye dönük doldurma
// ve model/boyut değiştiğinde yeniden gömme içindir.
//
// Konuşmaları TEK TEK değil, gruplar halinde gönderiyoruz: Voyage bir istekte
// metin listesi kabul ediyor. Ödeme yöntemi eklenmemiş hesapta kota dakikada
// 3 istek olduğu için, konuşma başına bir istek atmak kotayı hemen doldurur.
import type { Msg } from './parse';
import { getSupabase } from './supabase';
import { conversationEmbedText, setConversationEmbedding } from './store';
import { embed, embeddingEnabled } from './embed';
import { EMBED_MODEL } from './config';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Ücretsiz kotada dakikada 10K token sınırı var; grubu bunun altında tutuyoruz.
// Türkçe için ~3 karakter/token temkinli bir tahmin.
const TOKEN_BUDGET = 8000;
const MAX_BATCH = 16;
const estTokens = (s: string): number => Math.ceil(s.length / 3);

interface Item {
  id: string;
  slug: string;
  text: string;
}

// Hem adet hem tahmini token bütçesine göre gruplar. Tek başına bütçeyi aşan
// uzun bir konuşma kendi grubunda gider (Voyage'ın kendi sınırına bırakırız).
function batch(items: Item[]): Item[][] {
  const out: Item[][] = [];
  let cur: Item[] = [];
  let tokens = 0;
  for (const it of items) {
    const t = estTokens(it.text);
    if (cur.length && (cur.length >= MAX_BATCH || tokens + t > TOKEN_BUDGET)) {
      out.push(cur);
      cur = [];
      tokens = 0;
    }
    cur.push(it);
    tokens += t;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function main(): Promise<void> {
  if (!embeddingEnabled()) {
    throw new Error('VOYAGE_API_KEY .env içinde tanımlı değil. .env.example dosyasına bak.');
  }
  const supabase = getSupabase();
  const { data: convs, error } = await supabase
    .from('conversations')
    .select('id,slug')
    .order('created_at');
  if (error) throw new Error(error.message);

  const total = convs?.length ?? 0;
  console.log(`${total} konuşma bulundu. Model: ${EMBED_MODEL}\n`);

  const items: Item[] = [];
  let skipped = 0;
  for (const c of convs ?? []) {
    const { data: msgs } = await supabase
      .from('messages')
      .select('speaker,text')
      .eq('conversation_id', c.id)
      .order('position');
    const dialog: Msg[] = (msgs ?? []).map((m) => ({
      speaker: m.speaker === 'customer' ? 'customer' : 'me',
      text: m.text,
    }));
    const text = conversationEmbedText(dialog);
    if (!text) {
      skipped++;
      console.log(`  - ${c.slug} (boş, atlandı)`);
      continue;
    }
    items.push({ id: c.id, slug: c.slug, text });
  }

  const groups = batch(items);
  if (groups.length > 1) console.log(`${items.length} konuşma, ${groups.length} istekte gönderilecek.\n`);

  let ok = 0;
  let failed = 0;
  for (const group of groups) {
    try {
      const vectors = await embed(
        group.map((g) => g.text),
        'document',
      );
      for (let i = 0; i < group.length; i++) {
        await setConversationEmbedding(supabase, group[i].id, vectors[i]);
        ok++;
        console.log(`  ✓ ${group[i].slug}`);
      }
    } catch (e) {
      failed += group.length;
      for (const g of group) console.log(`  ✗ ${g.slug}: ${errMsg(e)}`);
    }
  }

  console.log(`\nBitti. Gömülen: ${ok}, atlanan: ${skipped}, hata: ${failed}.`);
}

main().catch((e) => {
  console.error('Hata:', errMsg(e));
  process.exit(1);
});
