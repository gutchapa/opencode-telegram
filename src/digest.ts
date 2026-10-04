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
   'Mac user running opencode AND OpenClaw; cost-sensitive; prefers free/open tools; plain office/doc work; no enterprise needs.';

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

function claimFile(day = todayStr()): string {
  return join(STATE_DIR, `digest-claim-${day}`);
}

// Atomic once-per-day claim across processes: two bot instances ticking the
// same minute must not both send. 'wx' creation fails if the file exists,
// so exactly one process wins; stale claims are namespaced by date.
export function claimDigestDay(): boolean {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(claimFile(), String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

export function releaseDigestClaim(): void {
  try {
    const { unlinkSync } = require('fs');
    unlinkSync(claimFile());
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

async function fetchRaw(): Promise<{ radar: string; tracked: string; news: string; arxivBest: string; gh1: string; gh2: string }> {
  const dir = pkgDigestDir();
  const py = process.env.PYTHON_BIN || 'python3';
  const [radar, tracked, arxivBest] = await Promise.all([
    runFetcher(py, [join(dir, 'github-radar.py')]),
    runFetcher(py, [join(dir, 'github-digest.py'), '--since', '24']),
    runFetcher(py, [join(dir, 'arxiv-best.py'), '--max', '8']),
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
  const q1 = 'q=topic:ai+created:%3E2026-07-01&sort=stars&order=desc&per_page=10';
  const q2 = 'q=ai+created:%3E2026-07-15&sort=stars&order=desc&per_page=15';
  const [r1, r2] = await Promise.all([gh(q1), gh(q2)]);
  // Same query, same results — gh CLI carries auth when the plain endpoint
  // is rate-limited (this is what the old briefing relied on).
  const [gh1, gh2] = await Promise.all([
    ghWithCliFallback(q1, r1),
    ghWithCliFallback(q2, r2),
  ]);
  return { radar, tracked, news: await fetchNews(), arxivBest, gh1, gh2 };
}

// HN Algolia: today's top AI stories, one cheap call (~2s). Without this
// the prompt's NEWS section has no source once browsing is disallowed.
async function fetchNews(): Promise<string> {
  try {
    const since = Math.floor(Date.now() / 1000) - 86400;
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=8`;
    const res = await fetch(url, { headers: { 'User-Agent': 'opencode-telegram-digest' }, signal: AbortSignal.timeout(20000) });
    const j: any = await res.json();
    const lines = (j.hits || []).map((h: any) => `* ${h.title || ''} (${h.points || 0} pts)`);
    return lines.length ? lines.join('\n') : '(no AI news in the last 24h)';
  } catch {
    return '(news unavailable)';
  }
}

// Authenticated gh-CLI fallback: when the plain GitHub API rate-limits,
// retry the identical query through `gh api` (same query, same results).
async function ghWithCliFallback(q: string, plain: string): Promise<string> {
  if (plain && !isRateLimited(plain)) return plain;
  try {
    const { stdout } = await execFileAsync('gh', ['api', `search/repositories?${q}`], { timeout: 25000, maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim().slice(0, 6000) || plain;
  } catch {
    return plain;
  }
}

function isRateLimited(body: string): boolean {
  return /rate limit|API rate limit exceeded|403/.test(body.slice(0, 500));
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

function buildPrompt(dateStr: string, raw: { radar: string; tracked: string; news: string; arxivBest: string; gh1: string; gh2: string }, previous: string): string {
  const manifest = readManifest();
  return `Generate the daily AI Morning Briefing and output ONLY the briefing text (no preamble, no commentary).
PART 1 — DIGEST (keep this exact format):
🌅 AI Morning Briefing — ${dateStr}
📰 NEWS: 🔴 Top Story (1 item), 📌 Major News (4-6 items), 🧰 New Tools & Releases (2-4 items). Use today's top AI news; prefer fresh sources. Work ONLY from the dumps below — no web browsing. Verify installs with at most 6 shell checks total (which/ls/brew list), then write.
🐙 GITHUB TRENDING — NEW AI REPOS: from the GitHub API dumps below, list: name ⭐stars — one-line description.
📄 PAPERS: max 3 from RAW ARXIV BEST below, skip entirely if none are relevant to the fitment context. Total briefing length unchanged — keep every other section tight to fit.
DEDUPE: skip any repo already listed in the PREVIOUS BRIEFINGS section — do not re-list repeats.
PART 2 — 🎯 FITMENT (mandatory final section):
Assess EVERY news item and EVERY repo against this context: ${FITMENT_CONTEXT}
ALREADY DEPLOYED — DO NOT SUGGEST (mark already have, never recommend installing).
Authoritative list, verified across runs:
${manifest}
Learning rule: if your live shell checks confirm a stable setup item (installed app, brew package, running service, configured tool) missing above, append it with: python3 -c "import json; p='${manifestPath()}'; d=json.load(open(p)); d['items'].append({'name':'<name>','note':'<one line>','added':'<today YYYY-MM-DD>','by':'briefing'}); json.dump(d,open(p,'w'),indent=2)". Additions only — never remove or edit existing entries.
For each item emit EXACTLY one bullet in this literal shape (glyph is mandatory, not optional):
• <name> — ✅ useful (<one line: why + what to do>)
• <name> — ⏭️ skip (<one line reason: 'duplicate of OpenClaw', 'paid plan', 'not our use case', 'news only', 'already have'>)
Few-shot (copy this style):
• elder-plinius/T3MP3ST — ⏭️ skip (offensive security; not our use case)
• Leonxlnx/unlazy — ✅ useful (free/open anti-laziness skill; port its Depth-Tree idea into an OpenClaw skill)
A verdict bullet without a leading ✅ or ⏭️ glyph is malformed — never emit one.
End with a one-line bottom line: what to install/change today (usually 'nothing').
Verification rule: every installed / already-have / duplicate verdict must be backed by a live shell check you ran in THIS run (ls, which, brew list, mdfind). If a check is denied or tools are unavailable, mark that verdict unverified instead of guessing — never assert installation state you did not observe.
Keep the section tight — bullets, no essays. Plain text only: NO Markdown formatting (no asterisks, underscores, backticks, hashes, brackets) — the transport rejects it.

RAW RADAR:
${raw.radar}

TODAY'S AI NEWS (HN, last 24h — use for the NEWS section):
${raw.news}

RAW TRACKED ACTIVITY:
${raw.tracked}

RAW ARXIV BEST (scored papers — use for the PAPERS line, max 3, skip if irrelevant):
${raw.arxivBest}

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

// Idempotency: opencode may invoke the plugin server function multiple times
// in one process (reload, reconnect, multi-directory). Without this guard
// every invocation spawned its own setInterval -> N schedulers ticking every
// minute ("firing 6 times in the log"). First call wins, rest are no-ops.
let schedulerStarted = false;

export function startDigestScheduler(getChatId: () => number | null): void {
  if (schedulerStarted) {
    console.log('Daily digest scheduler already armed — skipping duplicate start');
    return;
  }
  schedulerStarted = true;
  const timer = setInterval(() => {
    try {
      if (!isDigestEnabled()) return;
      // Dry runs never mark the day done (no send, no archive), so without
      // this guard a DRY_RUN process would burn a model call every minute.
      if (process.env.TELEGRAM_DIGEST_DRY_RUN) return;
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      // Due once daily at/after the scheduled time (not an exact-minute
      // match, so late starts and cooldown retries still fire the same day).
      if (hhmm < digestTime()) return;
      if (lastRun() === todayStr(now)) return;
      if (Date.now() - lastFailAt < FAIL_COOLDOWN_MS) return;
      // Check the chat target BEFORE claiming the day: a chat-less tick
      // must not burn the once-per-day claim, or the digest can never
      // fire later that day no matter how much the user chats.
      const chatId = Number(process.env.DIGEST_CHAT_ID) || getChatId();
      if (!chatId) {
        console.log('Digest due but no chat target (no active chat yet)');
        return;
      }
      if (!claimDigestDay()) return; // another process claimed this day
      // markRun happens inside runDailyDigest on success only; a failed run
      // releases the claim and cools down for an hour instead of retrying
      // every minute.
      runDailyDigest(chatId).catch((e: any) => {
        // A /stop-cancelled digest releases the day (retryable via /digest)
        // but must not burn the 1h failure cooldown.
        releaseDigestClaim();
        if (e?.cancelled) {
          console.log('Scheduled digest stopped by user — claim released, no cooldown.');
          return;
        }
        lastFailAt = Date.now();
        console.error('Scheduled digest failed:', e.message);
      });
    } catch (e: any) {
      console.error('Digest scheduler tick failed:', e.message);
    }
  }, 60000);
  // Never pin the host event loop: the plugin must not keep opencode alive
  // on its own, and standalone mode is held open by the Telegram poller.
  (timer as any)?.unref?.();
  console.log(`Daily digest scheduler armed (${digestTime()}, enabled=${isDigestEnabled()})`);
}
