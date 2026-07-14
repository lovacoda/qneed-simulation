// Mevcut tüm konuşmaların anlam parmak izini (embedding) toplu üretir/tazeler.
// Kullanım: npm run embed
// Yeni eklenen konuşmalar zaten otomatik gömülür; bu komut geriye dönük doldurma
// ve model/boyut değiştiğinde yeniden gömme içindir.
import type { Msg } from './parse';
import { getSupabase } from './supabase';
import { updateConversationEmbedding } from './store';
import { embeddingEnabled } from './embed';
import { EMBED_MODEL } from './config';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
  let ok = 0;
  let skipped = 0;
  let failed = 0;

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
    try {
      const done = await updateConversationEmbedding(supabase, c.id, dialog);
      if (done) {
        ok++;
        console.log(`  ✓ ${c.slug}`);
      } else {
        skipped++;
        console.log(`  - ${c.slug} (boş, atlandı)`);
      }
    } catch (e) {
      failed++;
      console.log(`  ✗ ${c.slug}: ${errMsg(e)}`);
    }
  }

  console.log(`\nBitti. Gömülen: ${ok}, atlanan: ${skipped}, hata: ${failed}.`);
}

main().catch((e) => {
  console.error('Hata:', errMsg(e));
  process.exit(1);
});
