/**
 * Decode a script body from any supported export into plain source.
 *
 * - Admin UI exports store the source as a JSON string inside a string ("\"var a = 1;\""),
 *   so JSON.parse is applied until the result stops being a JSON string literal.
 * - Frodo exports store an array of lines.
 * - Raw AM REST exports store base64.
 */
export function decodeScript(raw: unknown): string {
  if (raw == null) return '';
  if (Array.isArray(raw)) return raw.map((l) => String(l)).join('\n');
  if (typeof raw !== 'string') return String(raw);

  let text = raw;
  for (let i = 0; i < 10; i++) {
    const t = text.trim();
    if (!(t.startsWith('"') && t.endsWith('"')) && !(t.startsWith('[') && t.endsWith(']'))) break;
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed === 'string') {
        text = parsed;
        continue;
      }
      if (Array.isArray(parsed) && parsed.every((l) => typeof l === 'string')) {
        text = parsed.join('\n');
      }
    } catch {
      // Not JSON: keep as source.
    }
    break;
  }

  const b64 = tryBase64(text);
  return b64 ?? text;
}

function tryBase64(text: string): string | undefined {
  const t = text.trim();
  if (t.length < 8 || t.length % 4 !== 0) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return undefined;
  let decoded: string;
  try {
    decoded = decodeBase64Utf8(t);
  } catch {
    return undefined;
  }
  // Accept only readable text that looks like code.
  const printable = decoded.replace(/[\x20-\x7e\t\r\n -￿]/g, '');
  if (printable.length > 0) return undefined;
  if (!/[;(){}=]/.test(decoded)) return undefined;
  return decoded;
}

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
