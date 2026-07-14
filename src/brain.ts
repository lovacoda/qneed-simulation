import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY } from './config';
import { getSupabase } from './supabase';
import { embedOne, embeddingEnabled } from './embed';
import { matchConversations } from './store';

export function getAnthropic(): Anthropic {
  if (!ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY .env içinde tanımlı olmalı. .env.example dosyasına bak.',
    );
  }
  return new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}

// Nötr rol + tarzın tamamen örnek konuşmalardan öğrenilmesi talimatı.
const ROLE = `Sen bir kozmetik satış danışmanısın ve bir kişinin (satıcının) yapay zeka ikizisin.
Görevin: müşteriyle doğal bir WhatsApp sohbeti kurup ihtiyacını anlayarak uygun ürünü sattırmak.
Türkçe konuş.

TARZ — EN ÖNEMLİ KURAL (satış akışından ÖNCE gelir):
Aşağıda satıcının GERÇEK yazışmaları var. "Ben:" satırları satıcının (senin) gerçek yazı tarzı. Bu tarzı BİREBİR eşle:
- Büyük/küçük harf: satıcı küçük harfle yazıyorsa sen de küçük harfle yaz.
- Emoji: satıcı emoji kullanmıyorsa SEN DE kullanma; kullanıyorsa aynı sıklıkta kullan.
- Uzunluk: satıcı kısa yazıyorsa kısa yaz (aynı cümle sayısı/uzunluğu).
- Kelime seçimi, hitaplar, noktalama, yazım alışkanlıkları da aynı olsun.
Satıcının örneklerinde OLMAYAN selamlama, emoji, "hoş geldiniz", "size nasıl yardımcı olabilirim" gibi kalıpları ve fazladan soruları EKLEME. Kendinden üslup uydurma.
Satış oyun kitabı ile tarz çelişirse TARZI uygula — oyun kitabı sadece sohbetin akışını yönlendirir, üslubunu değil.
Hiç örnek yoksa sade, doğal bir Türkçe kullan; abartılı bir kişilik takınma.`;

const PLAYBOOK = `### SATIŞ OYUN KİTABI
1. Karşılama: örnek konuşmalardaki tarzda selam ver, tek soruyla sohbeti başlat.
2. İhtiyaç keşfi: cilt tipi/sorunu, daha önce ne kullandı, varsa bütçe. Aynı anda tek soru.
3. Öneri: SADECE katalogdaki üründen öner. Faydayı müşterinin sorununa bağla, özellik listesi yapma.
4. İtiraz karşılama: fiyat/kararsızlık/güven itirazlarını dürüst ve sakin karşıla; baskı yapma.
5. Kapanış: net bir teklif + kolay bir sonraki adım.
6. Sipariş: müşteri almak isterse ürün + adet + ad-soyad + adres + telefon topla, özetle ve
   "siparişini ekibe aktarıyorum, onaylayıp kargolayacağız" de. (Ödeme/kargo entegrasyonu henüz yok.)`;

const GUARDRAILS = `### KURALLAR (kesinlikle uy)
- Sağlık/tıbbi iddia YASAK: "hastalığı iyileştirir/tedavi eder" deme. Sadece kozmetik fayda.
- Alerji, gebelik, cilt hastalığı, ilaç durumunda dermatoloğa/uzmana yönlendir.
- Fiyat UYDURMA. Katalogda fiyat tutulmuyor; fiyat sorulursa "fiyatı kontrol edip hemen döneyim" de.
- Katalogda olmayan ürünü varmış gibi anlatma.
- Gereksiz kişisel veri isteme (KVKK). Sadece siparişi tamamlamak için gerekeni iste.
- Karmaşık şikayet, iade, ödeme sorunu → "sizi ekibimize aktarıyorum" diyerek insana devret.
- Dürüst ol: ürün müşteriye uygun değilse açıkça söyle.`;

// Düzenlenebilir ana talimatlar (rol + oyun kitabı + kurallar). Kullanıcı arayüzden
// değiştirirse data/prompt.md dosyasına yazılır; dosya yoksa aşağıdaki varsayılan kullanılır.
const INSTRUCTIONS_PATH = path.resolve(process.cwd(), 'data/prompt.md');

export const DEFAULT_INSTRUCTIONS = [ROLE, PLAYBOOK, GUARDRAILS].join('\n\n');

export function readInstructions(): string {
  try {
    const t = fs.readFileSync(INSTRUCTIONS_PATH, 'utf8').trim();
    return t || DEFAULT_INSTRUCTIONS;
  } catch {
    return DEFAULT_INSTRUCTIONS;
  }
}

export function writeInstructions(text: string): void {
  fs.mkdirSync(path.dirname(INSTRUCTIONS_PATH), { recursive: true });
  fs.writeFileSync(INSTRUCTIONS_PATH, typeof text === 'string' ? text : '', 'utf8');
}

// İsteğe bağlı işletme notu (data/persona.md). Tarz DEĞİL — sadece marka/işletme bilgisi.
function readBusinessNote(): string {
  const p = path.resolve(process.cwd(), 'data/persona.md');
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}

async function loadProducts(): Promise<string> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.from('products').select('*').order('name');
    if (error || !data || data.length === 0) return '';
    const lines = data.map((p) => {
      const extra = [
        p.category ? `(${p.category})` : null,
        p.good_for ? `Kime uygun: ${p.good_for}` : null,
        p.description ?? null,
      ]
        .filter(Boolean)
        .join(' — ');
      return `- ${p.name}${extra ? ' — ' + extra : ''}`;
    });
    return `### ÜRÜN KATALOĞU (SADECE bunları öner)\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

const MAX_EXAMPLES = 8;
// Bunun altındaki benzerlik "alakasız" sayılır; prompta zorla doldurmayız.
// Voyage skorları sıkışık aralıkta olduğu için 0.30 seçildi (gerçek testte
// konunun kendi en iyi eşleşmesi ~0.33 çıkıyordu; 0.35 onu bile eliyordu).
const SIMILARITY_THRESHOLD = 0.3;

interface ExampleRef {
  id: string;
  title: string | null;
  outcome: string | null;
}

// Prompta girecek konuşmaları seçer. Öncelik sırası:
//   1) "örnek" (is_exemplar) işaretli konuşmalar — her zaman girer (elle kürasyon).
//   2) sorgu varsa: gelen müşteri mesajına anlamca en yakın konuşmalar (RAG).
//   3) hâlâ boşluk varsa (önizleme, anahtar yok, soğuk başlangıç): kaliteye göre doldur.
async function pickExamples(supabase: ReturnType<typeof getSupabase>, query?: string): Promise<ExampleRef[]> {
  const picked: ExampleRef[] = [];
  const seen = new Set<string>();
  const add = (c: ExampleRef) => {
    if (picked.length >= MAX_EXAMPLES || seen.has(c.id)) return;
    picked.push(c);
    seen.add(c.id);
  };

  // 1) İşaretli örnekler her zaman.
  const { data: exemplars } = await supabase
    .from('conversations')
    .select('id,title,outcome')
    .eq('is_exemplar', true)
    .order('quality', { ascending: false })
    .limit(MAX_EXAMPLES);
  for (const c of exemplars ?? []) add(c as ExampleRef);

  // 2) Alakaya göre (retrieval).
  if (query && embeddingEnabled() && picked.length < MAX_EXAMPLES) {
    try {
      const qvec = await embedOne(query, 'query');
      const matches = await matchConversations(supabase, qvec, MAX_EXAMPLES * 2);
      for (const m of matches) {
        if (picked.length >= MAX_EXAMPLES) break;
        if (m.similarity < SIMILARITY_THRESHOLD) continue;
        add({ id: m.id, title: m.title, outcome: m.outcome });
      }
    } catch (e) {
      console.warn(`[retrieval] arama başarısız, kaliteye düşülüyor: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 3) Kaliteye göre doldur (yedek).
  if (picked.length < MAX_EXAMPLES) {
    const { data: byQuality } = await supabase
      .from('conversations')
      .select('id,title,outcome')
      .order('quality', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(MAX_EXAMPLES);
    for (const c of byQuality ?? []) add(c as ExampleRef);
  }

  return picked;
}

// Tarz kaynağı: gelen müşteri mesajına (query) en uygun konuşmalar. Sorgu yoksa
// kaliteye göre temsili bir set gösterilir. En fazla MAX_EXAMPLES konuşma girer.
async function loadStyleExamples(query?: string): Promise<string> {
  try {
    const supabase = getSupabase();
    const refs = await pickExamples(supabase, query);
    if (refs.length === 0) return '';

    const blocks: string[] = [];
    for (const c of refs) {
      const { data: msgs } = await supabase
        .from('messages')
        .select('speaker,text')
        .eq('conversation_id', c.id)
        .order('position');
      if (!msgs || msgs.length === 0) continue;
      const dialog = msgs
        .map((m) => `${m.speaker === 'customer' ? 'Müşteri' : 'Ben'}: ${m.text}`)
        .join('\n');
      blocks.push(`[Konuşma — ${c.title ?? ''} (sonuç: ${c.outcome})]\n${dialog}`);
    }
    if (blocks.length === 0) return '';

    return (
      `### SATICININ GERÇEK KONUŞMALARI (tarzını BURADAN öğren)\n` +
      `Aşağıdaki "Ben:" satırları senin gerçek yazı tarzın. Aynı tonu, kelimeleri, emoji ve ` +
      `yazım alışkanlıklarını taklit et. Bunlar senaryo değil — kopyalama, tarzı yansıt.\n\n` +
      blocks.join('\n\n')
    );
  } catch {
    return '';
  }
}

// query: o anki müşteri mesajı. Verilirse örnekler ona göre seçilir (RAG);
// verilmezse (önizleme) kaliteye göre temsili bir set gösterilir.
export async function buildSystemPrompt(query?: string): Promise<string> {
  const note = readBusinessNote();
  const instructions = readInstructions();
  const [products, examples] = await Promise.all([loadProducts(), loadStyleExamples(query)]);
  return [
    instructions,
    note ? `### İŞLETME NOTU (bilgi — tarz değil)\n${note}` : '',
    products,
    examples,
  ]
    .filter(Boolean)
    .join('\n\n');
}
