import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { runOpencodeAgentic } from './ai-handler';
import { sendTextToChat } from './runtime/telegram-bot';

const execFileAsync = promisify(execFile);

// Daily digest, bundled with the plugin (surprise feature, disable with
// DIGEST_ENABLED=0 or /digest off). Flow: fetch raw data -> opencode run
// (free-tier model formats + judges fitment) -> chunked Telegram send.
const STATE_DIR = join(process.env.HOME || '/Users/gutchapa', '.opencode-telegram-state');
const LAST_RUN_FILE = join(STATE_DIR, 'last-digest-date');
const FITMENT_CONTEXT =
  process.env.DIGEST_CONTEXT ||
  'Mac user running opencode; cost-sensitive; prefers free/open tools; plain office/doc work; no enterprise needs.';

function digestHome(): string {
  return process.env.DIGEST_HOME || join(process.env.HOME || '/Users/gutchapa', '.config/github-digest');
}

// Deployed manifest: the running memory of the stable setup, shared with
// the standalone wrapper. Read for fitment; the model may append
// newly-verified stable items (additions only) via the prompt rule below.
function readManifest(): string {
  try {
    const p = join(digestHome(), 'deployed.json');
    if (!existsSync(p)) return '(manifest empty)';
    const d = JSON.parse(readFileSync(p, 'utf-8'));
    const items = (d.items || []).map((i: any) => `- ${i.name} — ${i.note || ''}`);
    return items.length ? items.join('\n') : '(manifest empty)';
  } catch {
    return '(manifest unreadable)';
  }
}

function manifestPath(): string {
  return join(digestHome(), 'deployed.json');
}

export function isDigestEnabled(): boolean {
  const v = (process.env.DIGEST_ENABLED || '1').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

export function setDigestEnabled(on: boolean): void {
  process.env.DIGEST_ENABLED = on ? '1' : '0';
}

function digestTime(): string {
  return (process.env.DIGEST_TIME || '07:30').trim();
}

function todayStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function lastRun(): string {
  try {
    if (existsSync(LAST_RUN_FILE)) return readFileSync(LAST_RUN_FILE, 'utf-8').trim();
  } catch { /* ignore */ }
  return '';
}

function markRun(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(LAST_RUN_FILE, todayStr());
  } catch { /* ignore */ }
}

function pkgDigestDir(): string {
  // digest/ fetchers ship inside the published package next to dist/.
  const here = dirname(__filename);
  const cand = join(here, '..', 'digest');
  return existsSync(join(cand, 'github-radar.py')) ? cand : join(process.cwd(), 'digest');
}

async function runFetcher(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim() || '(unavailable)';
  } catch (e: any) {
    return `(unavailable: ${(e.message || '').slice(0, 120)})`;
  }
}

async function fetchRaw(): Promise<{ radar: string; tracked: string; gh1: string; gh2: string }> {
  const dir = pkgDigestDir();
  const py = process.env.PYTHON_BIN || 'python3';
  const [radar, tracked] = await Promise.all([
    runFetcher(py, [join(dir, 'github-radar.py')]),
    runFetcher(py, [join(dir, 'github-digest.py'), '--since', '24']),
  ]);
  const gh = async (q: string): Promise<string> => {
    try {
      const headers: Record<string, string> = { 'User-Agent': 'opencode-telegram-digest' };
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      const res = await fetch(`https://api.github.com/search/repositories?${q}`, { headers, signal: AbortSignal.timeout(25000) });
      const j = await res.json();
      return JSON.stringify(j).slice(0, 6000);
    } catch {
      return '{}';
    }
  };
  const [gh1, gh2] = await Promise.all([
    gh('q=topic:ai+created:%3E2026-07-01&sort=stars&order=desc&per_page=10'),
    gh('q=ai+created:%3E2026-07-15&sort=stars&order=desc&per_page=15'),
  ]);
  return { radar, tracked, gh1, gh2 };
}

function previousBriefings(): string {
  try {
    const { readdirSync, readFileSync } = require('fs');
    const home = process.env.DIGEST_HOME || join(process.env.HOME || '/Users/gutchapa', '.config/github-digest');
    const dir = join(home, 'sent');
    const files = readdirSync(dir)
      .filter((f: string) => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, 3);
    if (!files.length) return '(no previous briefings)';
    return files.map((f: string) => `--- ${f} ---\n${readFileSync(join(dir, f), 'utf-8').slice(0, 3000)}`).join('\n');
  } catch {
    return '(no previous briefings)';
  }
}

function buildPrompt(dateStr: string, raw: { radar: string; tracked: string; gh1: string; gh2: string }, previous: string): string {
  const manifest = readManifest();
  return `Generate the daily AI Morning Briefing and output ONLY the briefing text (no preamble, no commentary).
PART 1 — DIGEST (keep this exact format):
🌅 AI Morning Briefing — ${dateStr}
📰 NEWS: Top Story (1 item), Major News (4-6 items), New Tools & Releases (2-4 items). Use today's top AI news; prefer fresh sources.
🐙 GITHUB TRENDING — NEW AI REPOS: from the GitHub API dumps below, list: name ⭐stars — one-line description.
DEDUPE: skip any repo already listed in the PREVIOUS BRIEFINGS section — do not re-list repeats.
PART 2 — FITMENT (mandatory final section):
Assess EVERY news item and EVERY repo against this context: ${FITMENT_CONTEXT}
ALREADY DEPLOYED — DO NOT SUGGEST (mark already have, never recommend installing).
Authoritative list, verified across runs:
${manifest}
Learning rule: if your live shell checks confirm a stable setup item (installed app, brew package, running service, configured tool) missing above, append it with: python3 -c "import json; p='${manifestPath()}'; d=json.load(open(p)); d['items'].append({'name':'<name>','note':'<one line>','added':'<today YYYY-MM-DD>','by':'briefing'}); json.dump(d,open(p,'w'),indent=2)". Additions only — never remove or edit existing entries.
For each item: useful (one line: why + what to do) or skip (one line: reason — 'duplicate of what you run', 'paid plan', 'not our use case', 'news only', 'already have').
End with a one-line bottom line: what to install/change today (usually 'nothing').
Verification rule: every installed / already-have / duplicate verdict must be backed by a live shell check you ran in THIS run (ls, which, brew list, mdfind). If a check is denied or tools are unavailable, mark that verdict unverified instead of guessing — never assert installation state you did not observe.
Keep the section tight — bullets, no essays. Plain text only: NO Markdown formatting (no asterisks, underscores, backticks, hashes, brackets) — the transport rejects it.

RAW RADAR:
${raw.radar}

RAW TRACKED ACTIVITY:
${raw.tracked}

GITHUB API DUMP 1:
${raw.gh1}

GITHUB API DUMP 2:
${raw.gh2}

PREVIOUS BRIEFINGS (for dedupe):
${previous}`;
}

function stripPreamble(text: string): string {
  const i = text.indexOf('🌅');
  return (i >= 0 ? text.slice(i) : text).trim();
}

function chunk(text: string, n = 4000): string[] {
  const out: string[] = [];
  let s = text;
  while (s) {
    let cut = s.slice(0, n);
    const nl = cut.lastIndexOf('\n');
    if (nl > n / 2) cut = cut.slice(0, nl);
    out.push(cut);
    s = s.slice(cut.length);
  }
  return out;
}

export async function runDailyDigest(chatId: number): Promise<string> {
  const raw = await fetchRaw();
  const prompt = buildPrompt(
    new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
    raw,
    previousBriefings(),
  );
  let text = stripPreamble(await runOpencodeAgentic(prompt, 'digest', prompt, ''));
  if (!text) {
    throw new Error('digest agent produced no briefing');
  }
  if (process.env.TELEGRAM_DIGEST_DRY_RUN) {
    return text;
  }
  for (const part of chunk(text)) {
    await sendTextToChat(chatId, part);
  }
  try {
    const home = process.env.DIGEST_HOME || join(process.env.HOME || '/Users/gutchapa', '.config/github-digest');
    mkdirSync(join(home, 'sent'), { recursive: true });
    const d = new Date();
    writeFileSync(join(home, 'sent', `${todayStr(d)}.md`), text);
  } catch { /* archive is best-effort */ }
  markRun();
  return text;
}

let lastFailAt = 0;
const FAIL_COOLDOWN_MS = 3600000;

export function startDigestScheduler(getChatId: () => number | null): void {
  setInterval(() => {
    try {
      if (!isDigestEnabled()) return;
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      // Due once daily at/after the scheduled time (not an exact-minute
      // match, so late starts and cooldown retries still fire the same day).
      if (hhmm < digestTime()) return;
      if (lastRun() === todayStr(now)) return;
      if (Date.now() - lastFailAt < FAIL_COOLDOWN_MS) return;
      const chatId = Number(process.env.DIGEST_CHAT_ID) || getChatId();
      if (!chatId) {
        console.log('Digest due but no chat target (no active chat yet)');
        return;
      }
      // markRun happens inside runDailyDigest on success only; a failed run
      // cools down for an hour instead of retrying every minute.
      runDailyDigest(chatId).catch((e: any) => {
        lastFailAt = Date.now();
        console.error('Scheduled digest failed:', e.message);
      });
    } catch (e: any) {
      console.error('Digest scheduler tick failed:', e.message);
    }
  }, 60000);
  console.log(`Daily digest scheduler armed (${digestTime()}, enabled=${isDigestEnabled()})`);
}
