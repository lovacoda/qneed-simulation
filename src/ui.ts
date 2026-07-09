import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getAnthropic, buildSystemPrompt } from './brain';
import { getSupabase } from './supabase';
import { MODEL, ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } from './config';
import { parseDialog, parseTags, slugify } from './parse';
import {
  upsertConversation,
  upsertProduct,
  listConversations,
  getConversation,
  deleteConversation,
  listProducts,
  deleteProduct,
} from './store';

const PORT = Number(process.env.UI_PORT ?? 3939);
const PERSONA_PATH = path.resolve(process.cwd(), 'data/persona.md');
const HTML_PATH = path.resolve(process.cwd(), 'public/index.html');

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const shortId = (): string => Math.random().toString(36).slice(2, 7);

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, any>> {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Geçersiz JSON gövdesi.');
  }
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const p = url.pathname;
  const method = req.method ?? 'GET';

  try {
    // --- Statik sayfa ---
    if (method === 'GET' && p === '/') {
      const html = fs.readFileSync(HTML_PATH, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // --- Durum ---
    if (method === 'GET' && p === '/api/state') {
      return sendJson(res, 200, {
        hasAnthropic: !!ANTHROPIC_API_KEY,
        hasSupabase: !!(SUPABASE_URL && SUPABASE_SERVICE_KEY),
        model: MODEL,
      });
    }

    // --- Persona (data/persona.md) ---
    if (p === '/api/persona') {
      if (method === 'GET') {
        let text = '';
        try {
          text = fs.readFileSync(PERSONA_PATH, 'utf8');
        } catch {
          /* dosya yoksa boş döner */
        }
        return sendJson(res, 200, { text });
      }
      if (method === 'POST') {
        const b = await readJson(req);
        fs.mkdirSync(path.dirname(PERSONA_PATH), { recursive: true });
        fs.writeFileSync(PERSONA_PATH, typeof b.text === 'string' ? b.text : '', 'utf8');
        return sendJson(res, 200, { ok: true });
      }
    }

    // --- Kurulan sistem promptu (önizleme) ---
    if (method === 'GET' && p === '/api/system-prompt') {
      const prompt = await buildSystemPrompt();
      return sendJson(res, 200, { prompt });
    }

    // --- Konuşmalar ---
    if (p === '/api/conversations') {
      const supabase = getSupabase();
      if (method === 'GET') return sendJson(res, 200, await listConversations(supabase));
      if (method === 'POST') {
        const b = await readJson(req);
        const dialog = parseDialog(String(b.dialog ?? ''));
        if (dialog.length === 0) {
          return sendJson(res, 400, {
            error: 'Diyalog boş ya da "müşteri:" / "ben:" formatına uymuyor.',
          });
        }
        const slug =
          (typeof b.slug === 'string' && b.slug.trim()) ||
          `${slugify(b.title || 'konusma')}-${shortId()}`;
        const id = await upsertConversation(supabase, {
          slug,
          title: b.title || null,
          channel: b.channel || 'whatsapp',
          outcome: b.outcome || 'unknown',
          is_exemplar: !!b.exemplar,
          quality: Number(b.quality) || 3,
          tags: parseTags(b.tags),
          dialog,
        });
        return sendJson(res, 200, { ok: true, id, slug });
      }
    }
    const convMatch = p.match(/^\/api\/conversations\/([^/]+)$/);
    if (convMatch) {
      const supabase = getSupabase();
      const id = decodeURIComponent(convMatch[1]);
      if (method === 'GET') return sendJson(res, 200, await getConversation(supabase, id));
      if (method === 'DELETE') {
        await deleteConversation(supabase, id);
        return sendJson(res, 200, { ok: true });
      }
    }

    // --- Ürünler ---
    if (p === '/api/products') {
      const supabase = getSupabase();
      if (method === 'GET') return sendJson(res, 200, await listProducts(supabase));
      if (method === 'POST') {
        const b = await readJson(req);
        if (!b.name || !String(b.name).trim()) {
          return sendJson(res, 400, { error: 'Ürün adı gerekli.' });
        }
        const slug =
          (typeof b.slug === 'string' && b.slug.trim()) ||
          `${slugify(String(b.name))}-${shortId()}`;
        await upsertProduct(supabase, {
          slug,
          name: String(b.name).trim(),
          price: b.price === '' || b.price == null ? null : Number(b.price),
          currency: b.currency || 'TRY',
          category: b.category || null,
          good_for: b.good_for || null,
          description: b.description || null,
        });
        return sendJson(res, 200, { ok: true, slug });
      }
    }
    const prodMatch = p.match(/^\/api\/products\/([^/]+)$/);
    if (prodMatch) {
      const supabase = getSupabase();
      const id = decodeURIComponent(prodMatch[1]);
      if (method === 'DELETE') {
        await deleteProduct(supabase, id);
        return sendJson(res, 200, { ok: true });
      }
    }

    // --- Sohbet (akış) ---
    if (method === 'POST' && p === '/api/chat') {
      const b = await readJson(req);
      const messages = Array.isArray(b.messages) ? b.messages : [];
      const anthropic = getAnthropic(); // anahtar yoksa fırlatır -> aşağıda JSON hata
      const system = await buildSystemPrompt();
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      });
      const stream = anthropic.messages.stream({
        model: MODEL,
        max_tokens: 2000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system,
        messages,
      });
      stream.on('text', (delta) => res.write(delta));
      try {
        await stream.finalMessage();
      } catch (e) {
        res.write(`\n[Hata: ${errMsg(e)}]`);
      }
      return res.end();
    }

    sendJson(res, 404, { error: 'bulunamadı' });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: errMsg(e) });
    else {
      try {
        res.end();
      } catch {
        /* yoksay */
      }
    }
  }
});

function openBrowser(u: string): void {
  if (process.env.UI_NO_OPEN) return;
  try {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = isWin ? ['/c', 'start', '', u] : [u];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* tarayıcı açılamazsa sorun değil */
  }
}

server.listen(PORT, () => {
  const urlStr = `http://localhost:${PORT}`;
  console.log(`\nqneed AI İkiz arayüzü hazır: ${urlStr}`);
  console.log('(Kapatmak için Ctrl+C)\n');
  openBrowser(urlStr);
});
