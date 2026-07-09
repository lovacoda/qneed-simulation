// Konuşma diyaloğu ayrıştırma + yardımcılar. Hem CLI ingest hem web arayüzü kullanır.

export interface Msg {
  speaker: 'customer' | 'me';
  text: string;
}

const CUSTOMER_PREFIXES = ['müşteri', 'musteri', 'customer', 'm'];
const ME_PREFIXES = ['ben', 'me', 'satıcı', 'satici', 's'];

export function speakerOf(prefix: string): 'customer' | 'me' | null {
  const p = prefix.trim().toLowerCase();
  if (CUSTOMER_PREFIXES.includes(p)) return 'customer';
  if (ME_PREFIXES.includes(p)) return 'me';
  return null;
}

// "müşteri: ...", "ben: ..." satırlarını mesajlara çevirir. Devam satırları
// (öneki olmayan) önceki mesaja eklenir.
export function parseDialog(body: string): Msg[] {
  const msgs: Msg[] = [];
  let current: Msg | null = null;
  for (const rawLine of body.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    const colon = line.indexOf(':');
    let matched = false;
    if (colon > 0) {
      const sp = speakerOf(line.slice(0, colon));
      if (sp) {
        current = { speaker: sp, text: line.slice(colon + 1).trim() };
        msgs.push(current);
        matched = true;
      }
    }
    if (!matched && current) {
      current.text += line.trim() ? '\n' + line.trim() : '\n';
    }
  }
  return msgs.map((m) => ({ ...m, text: m.text.trim() })).filter((m) => m.text.length > 0);
}

export function parseTags(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

const TR_MAP: Record<string, string> = {
  ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u',
  Ç: 'c', Ğ: 'g', İ: 'i', Ö: 'o', Ş: 's', Ü: 'u',
};

export function slugify(s: string): string {
  const ascii = s
    .split('')
    .map((ch) => TR_MAP[ch] ?? ch)
    .join('');
  return (
    ascii
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'kayit'
  );
}
