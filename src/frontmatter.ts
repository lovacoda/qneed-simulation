export interface Parsed {
  data: Record<string, string>;
  body: string;
}

// Basit YAML-benzeri front-matter ayrıştırıcı (harici bağımlılık yok).
// --- ile başlayıp --- ile biten "key: value" bloğunu okur.
export function parseFrontmatter(raw: string): Parsed {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text.trim() };

  const data: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) data[key] = val;
  }
  return { data, body: (m[2] ?? '').trim() };
}
