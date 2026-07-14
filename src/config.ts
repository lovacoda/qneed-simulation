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
