import dotenv from 'dotenv';

dotenv.config();

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
export const MODEL = process.env.MODEL ?? 'claude-opus-4-8';
