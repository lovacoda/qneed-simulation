// Embedding (anlam parmak izi) katmanı — sağlayıcı: Voyage AI.
// Konuşmaları ve gelen müşteri mesajını aynı vektör uzayına taşıyıp benzerlik
// aramasıyla "duruma uygun" konuşmaları buluruz (RAG). Sağlayıcıyı değiştirmek
// istersen SADECE bu dosyayı düzenle; gerisi embed()/embedOne() üzerinden çalışır.
import { VOYAGE_API_KEY, EMBED_MODEL, EMBED_DIM } from './config';

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

// input_type retrieval kalitesini artırır: konuşmalar 'document', gelen müşteri
// mesajı 'query' olarak gömülür (Voyage bunları asimetrik eşleştirir).
export type EmbedKind = 'document' | 'query';

export function embeddingEnabled(): boolean {
  return !!VOYAGE_API_KEY;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Ödeme yöntemi eklenmemiş Voyage hesabında kota dakikada 3 istek. Kotaya
// takılınca hata vermek yerine bekleyip yeniden deniyoruz; 20 sn o kotanın
// doğal periyodu. Sunucu Retry-After derse ona uyarız.
const MAX_RETRIES = 4;
const RETRY_WAITS_MS = [20_000, 20_000, 40_000, 60_000];

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const secs = Number(h);
  return Number.isFinite(secs) ? secs * 1000 : null;
}

export async function embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
  if (!VOYAGE_API_KEY) {
    throw new Error('VOYAGE_API_KEY .env içinde tanımlı olmalı. .env.example dosyasına bak.');
  }
  // Boşları eleyip sessizce kısa liste döndürmüyoruz: çağıran vektörleri sıraya
  // göre eşliyor, kayma sessiz bir hata olurdu.
  const input = texts.map((t) => t.trim());
  if (input.length === 0) return [];
  if (input.some((t) => !t)) throw new Error('Boş metin gömülemez.');

  let res!: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        input,
        model: EMBED_MODEL,
        input_type: kind,
        output_dimension: EMBED_DIM,
      }),
    });
    if (res.status !== 429 || attempt >= MAX_RETRIES) break;
    const wait = retryAfterMs(res) ?? RETRY_WAITS_MS[attempt] ?? 60_000;
    console.warn(`[embed] Voyage kotası doldu, ${Math.round(wait / 1000)} sn bekleniyor...`);
    await sleep(wait);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Voyage embedding hatası (${res.status}): ${detail.slice(0, 300)}`);
  }

  const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
  const vectors = (json.data ?? []).map((d) => d.embedding);
  if (vectors.length !== input.length) {
    throw new Error(`Beklenen ${input.length} vektör, gelen ${vectors.length}.`);
  }
  return vectors;
}

export async function embedOne(text: string, kind: EmbedKind): Promise<number[]> {
  const [vec] = await embed([text], kind);
  if (!vec) throw new Error('Boş metin gömülemez.');
  return vec;
}
