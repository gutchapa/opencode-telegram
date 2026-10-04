import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// Guardrails: file deletions are strictly prohibited for bot-driven agent
// runs. Three layers (defense in depth — textual filters alone are
// bypassable, so no single layer is trusted):
//   1. Config layer (strongest available without a sandbox): explicit `deny`
//      rules injected via an OPENCODE_CONFIG merge layer. opencode honors
//      explicit denies even under --auto, so denied commands cannot run.
//   2. Prompt layer: OPERATOR_CHARTER forbids deletions; the agent must
//      propose removals in words (or via `trash` CLI) instead of deleting.
//   3. Slash layer: /execute runs through the plugin shell, untouched — the
//      human typing /execute is the explicit actor, not the agent.
// NOTE: a project-level opencode.json loads AFTER the custom layer and could
// re-allow a pattern. Project owners own their configs; the bot never writes
// project configs.
const STATE_DIR = join(process.env.HOME || '/Users/gutchapa', '.opencode-telegram-state');
const BOT_CONFIG_FILE = join(STATE_DIR, 'opencode.bot.json');

// bash glob -> effect. Deny destructive commands outright. `trash` (macOS
// recoverable delete) is deliberately NOT denied — it is the safe outlet.
const BASH_DENIES: Record<string, 'deny'> = {
  'rm *': 'deny',
  'rmdir *': 'deny',
  'unlink *': 'deny',
  'shred *': 'deny',
  'dd *': 'deny',
  'mkfs*': 'deny',
  'git clean *': 'deny',
  'git reset --hard*': 'deny',
  'git checkout .': 'deny',
  'git checkout -- *': 'deny',
  'find *-delete*': 'deny',
  'find *-exec rm*': 'deny',
  'mv * /dev/null': 'deny',
};

function botConfigContent(): string {
  return JSON.stringify({ permission: { bash: BASH_DENIES } }, null, 2) + '\n';
}

// Write (or refresh) the bot config layer. Returns its path, or null when
// the user already pins OPENCODE_CONFIG themselves — explicit user config
// wins, and we log that bot denies are inactive instead of clobbering it.
export function ensureBotConfig(): string | null {
  if ((process.env.OPENCODE_CONFIG || '').trim()) {
    console.log('OPENCODE_CONFIG already set by user — bot deny layer inactive (user config wins).');
    return null;
  }
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const want = botConfigContent();
    let have = '';
    try {
      have = readFileSync(BOT_CONFIG_FILE, 'utf-8');
    } catch { /* first run */ }
    if (have !== want) writeFileSync(BOT_CONFIG_FILE, want);
    return BOT_CONFIG_FILE;
  } catch (e: any) {
    console.error('Could not write bot guardrail config:', e.message);
    return null;
  }
}

export function deniedPatterns(): string[] {
  return Object.keys(BASH_DENIES);
}

// Phone-typo gate for /execute, /exec, /bash: destructive-looking strings
// never run on first send. The user confirms with /yes <token> (or drops
// with /no). Judges the final string, not intent — a typo that creates
// `rm -rf / tmp` is caught the same as a deliberate one.
const CONFIRM_EXTRAS = ['sudo *'];

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`, 's');
}

const DESTRUCTIVE_RES = [...Object.keys(BASH_DENIES), ...CONFIRM_EXTRAS].map(globToRegExp);

export function looksDestructive(cmd: string): boolean {
  const c = cmd.trim().replace(/\s+/g, ' ');
  return DESTRUCTIVE_RES.some((re) => re.test(c));
}

type Pending = { user: string; cmd: string; expiresAt: number };
const pending = new Map<string, Pending>();
const CONFIRM_TTL_MS = 5 * 60 * 1000;

export function requestConfirm(user: string, cmd: string): string {
  const { randomBytes } = require('crypto');
  const token = randomBytes(2).toString('hex');
  pending.set(`${user}:${token}`, { user, cmd, expiresAt: Date.now() + CONFIRM_TTL_MS });
  return token;
}

export function confirmPending(user: string, token: string): string | null {
  const key = `${user}:${token.trim().toLowerCase()}`;
  const p = pending.get(key);
  pending.delete(key);
  if (!p) return null;
  if (Date.now() > p.expiresAt) return null;
  return p.cmd;
}

export function cancelPending(user: string, token?: string): number {
  let n = 0;
  for (const [k, p] of pending) {
    if (p.user !== user) continue;
    if (token && k !== `${user}:${token.trim().toLowerCase()}`) continue;
    pending.delete(k);
    n += 1;
  }
  return n;
}
