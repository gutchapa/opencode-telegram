import { readFileSync } from 'fs';
import { join } from 'path';

export let botToken: string | null = null;

export function setBotToken(token: string): void {
  botToken = token;
}

export function getBotToken(): string | null {
  return botToken;
}

export function initializeBotToken(token: string): void {
  setBotToken(token);
}

function readConfigFile(): Record<string, unknown> {
  // dist/sdk or src/sdk -> project root
  const root = join(__dirname, '..', '..');
  try {
    return JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function readDotEnv(): Record<string, string> {
  const root = join(__dirname, '..', '..');
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolve the Telegram bot token without any hardcoded secret.
 * Precedence: plugin options > TELEGRAM_BOT_TOKEN env > config.json > .env.
 */
export function resolveBotToken(options?: Record<string, unknown>): string | null {
  if (options && typeof options.botToken === 'string' && options.botToken.trim()) {
    return options.botToken.trim();
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN.trim()) {
    return process.env.TELEGRAM_BOT_TOKEN.trim();
  }
  const cfg = readConfigFile();
  if (typeof cfg.botToken === 'string' && cfg.botToken.trim()) {
    return cfg.botToken.trim();
  }
  const env = readDotEnv();
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN.trim()) {
    return env.TELEGRAM_BOT_TOKEN.trim();
  }
  return null;
}
