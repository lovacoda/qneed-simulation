import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseFrontmatter } from './frontmatter';
import { parseDialog, parseTags } from './parse';
import { upsertConversation, upsertProduct } from './store';
import { getSupabase } from './supabase';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isTrue = (v?: string): boolean => /^(true|evet|yes|1)$/i.test(v ?? '');

async function ingestConversations(supabase: SupabaseClient): Promise<number> {
  const dir = path.resolve(process.cwd(), 'data/conversations');
  if (!fs.existsSync(dir)) {
    console.log('  data/conversations klasörü yok, atlanıyor.');
    return 0;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  let count = 0;
  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const { data, body } = parseFrontmatter(fs.readFileSync(path.join(dir, file), 'utf8'));
    const dialog = parseDialog(body);
    if (dialog.length === 0) {
      console.warn(`  ⚠ ${file}: mesaj bulunamadı, atlandı.`);
      continue;
    }
    const exemplar = isTrue(data.exemplar);
    try {
      await upsertConversation(supabase, {
        slug,
        title: data.title ?? slug,
        channel: data.channel ?? 'whatsapp',
        outcome: data.outcome ?? 'unknown',
        is_exemplar: exemplar,
        quality: data.quality ? parseInt(data.quality, 10) || 3 : 3,
        tags: parseTags(data.tags),
        notes: data.notes ?? null,
        happened_at: data.happened_at || null,
        dialog,
      });
      console.log(`  ✓ ${file} (${dialog.length} mesaj${exemplar ? ', örnek' : ''})`);
      count++;
    } catch (e) {
      console.error(`  ✗ ${file}:`, errMsg(e));
    }
  }
  return count;
}

async function ingestProducts(supabase: SupabaseClient): Promise<number> {
  const dir = path.resolve(process.cwd(), 'data/products');
  if (!fs.existsSync(dir)) {
    console.log('  data/products klasörü yok, atlanıyor.');
    return 0;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  let count = 0;
  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const { data, body } = parseFrontmatter(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!data.name) {
      console.warn(`  ⚠ ${file}: name alanı yok, atlandı.`);
      continue;
    }
    try {
      await upsertProduct(supabase, {
        slug,
        name: data.name,
        price: data.price ? Number(data.price) : null,
        currency: data.currency ?? 'TRY',
        category: data.category ?? null,
        good_for: data.good_for ?? null,
        description: body || data.description || null,
        // Belirtilmemişse undefined kalsın: arayüzden eklenmiş görseli ezmeyelim.
        image_url: data.image_url,
      });
      console.log(`  ✓ ${file} (${data.name})`);
      count++;
    } catch (e) {
      console.error(`  ✗ ${file}:`, errMsg(e));
    }
  }
  return count;
}

async function main(): Promise<void> {
  const supabase = getSupabase();
  console.log('Konuşmalar yükleniyor...');
  const c = await ingestConversations(supabase);
  console.log('\nÜrünler yükleniyor...');
  const p = await ingestProducts(supabase);
  console.log(`\nBitti. ${c} konuşma, ${p} ürün güncellendi.`);
}

main().catch((e) => {
  console.error('Hata:', errMsg(e));
  process.exit(1);
});
