import { readFileSync } from 'fs';
import { join } from 'path';
import https from 'https';
import { getBotToken } from './sdk/provider-auth';

export interface BotInfo {
  id: number;
  username: string;
  displayName: string;
}

let cached: BotInfo | null = null;
let fetched = false;

/** Live bot identity via Telegram getMe. Cached after first call; null when offline. */
export async function getBotInfo(): Promise<BotInfo | null> {
  if (cached) return cached;
  if (fetched) return null;
  fetched = true;
  const token = getBotToken();
  if (!token || token === 'dummy-audit-token') return null;
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const req = https.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 15000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('getMe timeout')));
    });
    const r = JSON.parse(raw).result;
    if (r && r.id) {
      cached = { id: r.id, username: r.username || '', displayName: r.first_name || '' };
    }
  } catch {
    /* offline — callers fall back to handle-only text */
  }
  return cached;
}

/** Plugin version from the plugin's own package.json (works regardless of CWD). */
export function getPluginVersion(): string {
  const candidates = [
    join(__dirname, '..', 'package.json'), // dist/bot-identity.js -> root
    join(__dirname, '..', '..', 'package.json'), // nested layouts
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8'));
      if (pkg.name === 'gutchapa-opencode-telegram' && pkg.version) return String(pkg.version);
    } catch {
      /* try next */
    }
  }
  return 'unknown';
}

/** Short owner/status lines shared by /start and /botinfo. */
export function formatUptime(): string {
  const s = Math.floor(process.uptime());
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}
