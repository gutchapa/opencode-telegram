import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { realpathSync } from 'fs';
import { homedir } from 'os';

// Project switching: the phone is not the bot workspace. The agent runs in
// the user's ACTIVE project (via `opencode run --dir`), not locked to
// ~/.opencode-bot-ws. Roots constrain where projects may live.
const STATE_DIR = join(process.env.HOME || '/Users/gutchapa', '.opencode-telegram-state');

function projectRoots(): string[] {
  const raw = (process.env.BOT_PROJECT_ROOTS || '').trim();
  const roots = raw ? raw.split(':').map((s) => s.trim()).filter(Boolean) : [homedir()];
  const out: string[] = [];
  for (const r of roots) {
    try {
      const rp = realpathSync(resolve(r.replace(/^~(?=\/|$)/, homedir())));
      if (existsSync(rp)) out.push(rp);
    } catch { /* skip unreadable roots */ }
  }
  // The bot workspace is always a valid project (back-compat default).
  try {
    const ws = realpathSync(join(process.env.HOME || '/Users/gutchapa', '.opencode-bot-ws'));
    if (existsSync(ws) && !out.includes(ws)) out.push(ws);
  } catch { /* ignore */ }
  return out;
}

function projectFile(user: string): string {
  const safe = user.replace(/[^0-9a-zA-Z_-]/g, '_');
  return join(STATE_DIR, `project-${safe}`);
}

function withinRoots(dir: string): boolean {
  return projectRoots().some((r) => dir === r || dir.startsWith(r + '/'));
}

export function getActiveProject(user: string): string {
  try {
    if (existsSync(projectFile(user))) {
      const p = readFileSync(projectFile(user), 'utf-8').trim();
      if (p && existsSync(p)) return p;
    }
  } catch { /* fall through to default */ }
  return join(process.env.HOME || '/Users/gutchapa', '.opencode-bot-ws');
}

export function setActiveProject(user: string, input: string): string {
  const expanded = input.replace(/^~(?=\/|$)/, homedir());
  let dir: string;
  try {
    dir = realpathSync(resolve(expanded));
  } catch {
    throw new Error(`No such directory: ${input}`);
  }
  let st;
  try {
    st = statSync(dir);
  } catch {
    throw new Error(`No such directory: ${input}`);
  }
  if (!st.isDirectory()) throw new Error(`Not a directory: ${input}`);
  if (!withinRoots(dir)) {
    throw new Error(`Outside allowed roots (${projectRoots().join(', ')}). Set BOT_PROJECT_ROOTS to widen.`);
  }
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(projectFile(user), dir + '\n');
  return dir;
}

export function listProjects(): string[] {
  const out: string[] = [];
  for (const r of projectRoots()) {
    out.push(r + '/');
    try {
      const names = readdirSync(r).slice(0, 200);
      for (const n of names) {
        if (n.startsWith('.')) continue;
        try {
          if (statSync(join(r, n)).isDirectory()) {
            out.push(join(r, n));
            if (out.length >= 50) return out;
          }
        } catch { /* skip */ }
      }
    } catch { /* unreadable root */ }
  }
  return out;
}

export function describeRoots(): string {
  return projectRoots().join(', ') || '(none)';
}
