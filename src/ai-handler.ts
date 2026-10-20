import { spawn, ChildProcess } from 'child_process';
import { setAiHandler, getRegisteredCommands } from './sdk/plugin-runtime';
import { getAgentState } from './agent-state';
import { appendMessage, getHistory, formatTranscript, HistoryEntry } from './conversation-memory';
import { getActiveProject } from './projects';
import { ensureBotConfig } from './guardrails';

const OPENCODE_BIN = process.env.OPENCODE_BIN || '/Users/gutchapa/.local/bin/opencode';
const OPENCODE_CWD = process.env.OPENCODE_CWD || '/Users/gutchapa/.opencode-bot-ws';
const OPENCODE_TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT_MS || 300000);
// Model for all bot replies, keyed in via the OPENCODE_MODEL environment
// variable (same pattern as OPENCODE_BIN / OPENCODE_CWD). When unset or
// empty, no --model flag is passed and the run inherits whatever model the
// bot's opencode config defines. Nothing is hardcoded here. Read live (not
// a load-time const) so /model can switch it without a restart.
export function getOpencodeModel(): string {
  return (process.env.OPENCODE_MODEL || '').trim();
}
export function getOpencodeModelLabel(): string {
  return getOpencodeModel() || "this bot's opencode-config default";
}

const AGENT_HARDENING_INSTRUCTION =
  'First decide: is this message a QUESTION (asking why, what, how, for an explanation or opinion) or a TASK (asking you to run, fetch, check, read, or change something)? ' +
  'If it is a QUESTION, answer it directly in words — do NOT run shell commands, do NOT re-run previous jobs like the digest, do NOT go gathering data unasked. ' +
  'If it is a TASK, do it NOW using your tools (read, grep, ls, bash) and report the concrete result. ' +
  'Never end with only intent such as "Let me read that file" or "I will check" - actually do it in this turn.';
const RETRY_NUDGE =
  'Your previous reply only promised to do the task instead of doing it. ' +
  'This time you MUST actually do the work with your tools and give the concrete result.';

// Operator charter: the bot is an extension of the user's desktop CLI, so it
// steers like one — same discipline as a coding-assistant harness:
// short/factual, evidence-backed, tool-disciplined, no loops.
const OPERATOR_CHARTER =
  'You are the user\'s own desktop assistant over Telegram, an extension of their CLI. ' +
  'Tone: short, direct, factual. Chat-sized replies, no essays, no flattery, no emojis unless asked. ' +
  'Truth: answer from evidence in this conversation or what your tools just returned. If unsure, say so plainly — never guess installation state, never assert what you did not observe. ' +
  'No loops: never repeat a previous reply or re-run a previous job (digest, stats, builds) unless explicitly asked. If challenged on a repeat, acknowledge it once and correct. ' +
  'Tools: independent calls in parallel; no shell, no file writes, no network fetches unasked. ' +
  'Links: when the user sends a URL with an action verb (check, fitment, review, summarize, fetch), fetch it FIRST with WebFetch or curl, then deliver the verdict. ' +
  'Never announce you have not opened a link — open it. Ask a clarifying question only when both the link AND the verb are missing. ' +
  'Deletions are strictly prohibited: never rm/unlink/shred/rmdir, never `git clean`, `git reset --hard`, or `git checkout .` — even if asked casually. ' +
  'Propose removals in words (or via the recoverable `trash` CLI) and let the human delete. ' +
  'Verify before claiming: report only what actually executed, with the concrete result. ' +
  'Receipt rule: after creating or editing files, prove it with `git status --short` plus `git diff --stat` (or `ls` of the new file) run in the same turn — a file change without a receipt did not happen. ' +
  'Memory: the goal/steer/focus lines below are standing orders — obey them across turns until cleared.';

const ALLOWED_USERS = (process.env.ALLOWED_TELEGRAM_USERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let agenticQueue: Promise<string | null> = Promise.resolve(null);
// Live run tracking so /stop actually stops: the in-flight child plus a
// count of queued-but-unstarted runs.
let currentChild: ChildProcess | null = null;
let queuedRuns = 0;

let runGeneration = 0;

export function stopAgenticRuns(): string {
  let stopped = 0;
  if (currentChild) {
    try {
      currentChild.kill('SIGKILL');
      stopped += 1;
    } catch { /* already dead */ }
    currentChild = null;
  }
  stopped += queuedRuns;
  queuedRuns = 0;
  // Invalidate the chain: already-attached closures check the generation at
  // start and abort instead of running. Resetting the variable alone would
  // NOT detach them.
  runGeneration += 1;
  agenticQueue = Promise.resolve(null);
  return stopped === 0
    ? 'Nothing running — no pending agentic runs.'
    : `Stopped ${stopped} pending agentic run${stopped === 1 ? '' : 's'}.`;
}

// Enqueue an opencode run behind the serial chain, counted for /stop and
// invalidated by generation bumps.
function enqueueRun(fn: () => Promise<string>): Promise<string> {
  queuedRuns += 1;
  const gen = runGeneration;
  const q = agenticQueue.then(() => {
    queuedRuns -= 1;
    if (gen !== runGeneration) {
      throw new Error('run cancelled by /stop');
    }
    return fn();
  });
  agenticQueue = q.then(() => null, () => null);
  return q;
}

// NOTE: an earlier version of this file contained a regex front-gate
// (SHELL_COMMANDS / INSPECT_* / extractShellCommand) that guessed shell
// commands from plain text before any model ran. It was removed: plain
// text now always goes to the model like openclaw. Explicit slash commands
// (/execute, /read, ...) still dispatch through the command layer.
// Response validators below judge model OUTPUT (fallback chains) — kept.

const UNFULFILLED_PROMISE_RE = [
  /\b(?:i'?ll|i will|we'?ll|we will)\s+(?:help you\s+)?(?:to\s+)?(?:read|check|look|examine|investigate|analyz|review|see|take a look|dig|explore|fetch|find|open|pull|verify|confirm|look into|work on|handle|take care of|get back)\w*\b/i,
  /\blet me\s+(?:first\s+|quickly\s+)?(?:read|check|look|examine|investigate|analyz|review|see|take a look|dig|explore|fetch|find|open|pull|verify|confirm|look into|handle|take care of)\w*\b/i,
  /\b(?:i'?m|i am)\s+(?:going to|about to)\s+(?:read|check|look|examine|investigate|analyz|review|start|try|find|open|verify|confirm|look into)\w*\b/i,
  /\blet me (?:take a )?look\b|\blet me read that (?:file|script|code)\b/i,
  /\b(?:one moment|just a moment|give me (?:a|one) (?:moment|sec|second)|bear with me|hold on|hang on|i'?ll get back to you)\b/i,
];

const DELIVERED_CONTENT_RE =
  /(?:```|here'?s|here is|here are|in short|turns out|conclusion|summary|found that|result is|output is|lines? \d+|imports|defines|contains|prints|reads|writes|creates|loads|loops|computes|calls|uses|returns|takes|based on)/i;

export function isUnfulfilledPromise(response: string): boolean {
  const t = response.trim();
  if (!t || t.length > 250) return false;
  if (DELIVERED_CONTENT_RE.test(t)) return false;
  return UNFULFILLED_PROMISE_RE.some((re) => re.test(t));
}

// In-process opencode SDK client, injected when this package runs as an opencode
// server plugin. When set, agentic replies run against the hosting server instead
// of spawning a nested `opencode run` process.
let opencodeClient: any = null;
let opencodeDirectory: string | undefined;
// OpenCode V2 plugin context. When present it takes precedence over both the V1
// in-process client and the subprocess path, because V2 sessions live inside the
// host that loaded the plugin.
let opencodeV2: any = null;
// Reuse one opencode session per chat so the SDK path keeps real multi-turn context.
const opencodeSessionIds = new Map<string, string>();

export function setV2Context(ctx: unknown): void {
  opencodeV2 = ctx;
}

function v2SessionIdOf(session: any): string | undefined {
  return session?.id ?? session?.data?.id;
}

// V2 returns SessionMessageInfo[] for ctx.session.context. Shapes vary by
// version, so accept both `parts` and `info.parts` and take the last assistant
// text block rather than assuming a fixed envelope.
function v2TextFromMessages(messages: any): string {
  const list: any[] = Array.isArray(messages) ? messages : [];
  const chunks: string[] = [];
  for (const message of list) {
    const role = message?.role ?? message?.info?.role;
    if (role && role !== 'assistant') continue;
    const parts = message?.parts ?? message?.info?.parts ?? [];
    for (const part of parts) {
      if (part?.type !== 'text') continue;
      if (part?.synthetic || part?.ignored) continue;
      if (typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('\n').replace(/\x1b\[[0-9;]*m/g, '').trim();
}

async function runAgenticViaV2(message: string, user: string): Promise<string> {
  let sessionId = opencodeSessionIds.get(user);
  if (!sessionId) {
    const created = await opencodeV2.session.create({
      title: `telegram:${new Date().toISOString()}`,
    });
    sessionId = v2SessionIdOf(created);
    if (!sessionId) {
      throw new Error('opencode v2 session create returned no session id');
    }
    opencodeSessionIds.set(user, sessionId);
    while (opencodeSessionIds.size > 50) {
      const oldest = opencodeSessionIds.keys().next();
      if (oldest.done) break;
      opencodeSessionIds.delete(oldest.value);
    }
  }

  try {
    await Promise.race([
      opencodeV2.session.prompt({ sessionID: sessionId, text: message }),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          Promise.resolve(opencodeV2.session.interrupt({ sessionID: sessionId })).catch(() => {});
          reject(new Error(`opencode v2 prompt timed out after ${OPENCODE_TIMEOUT_MS}ms`));
        }, OPENCODE_TIMEOUT_MS),
      ),
    ]);

    if (typeof opencodeV2.session.wait === 'function') {
      await Promise.race([
        opencodeV2.session.wait({ sessionID: sessionId }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`opencode v2 wait timed out after ${OPENCODE_TIMEOUT_MS}ms`)),
            OPENCODE_TIMEOUT_MS,
          ),
        ),
      ]);
    }

    const messages = await opencodeV2.session.context({ sessionID: sessionId });
    const text = v2TextFromMessages(messages);
    if (!text) {
      throw new Error('opencode v2 prompt produced no text');
    }
    return cleanFences(text);
  } catch (error) {
    // Drop the session so the next turn starts clean.
    opencodeSessionIds.delete(user);
    throw error;
  }
}

export function setOpencodeClient(client: unknown, directory?: string): void {
  opencodeClient = client;
  if (directory) opencodeDirectory = directory;
  // The SDK session path cannot take a per-run --model flag: server-side
  // sessions use the server's model. Say so loudly instead of silently
  // ignoring OPENCODE_MODEL.
  if (client && getOpencodeModel()) {
    console.warn(
      `OPENCODE_MODEL=${getOpencodeModel()} is set, but the in-process SDK path ` +
        `ignores it (server sessions use the server model). Unset it to silence this.`,
    );
  }
}

export function resetOpencodeSessions(): void {
  opencodeSessionIds.clear();
}

function buildSystemPrompt(): string {
  const now = new Date();
  const dateTime = now.toLocaleString('en-IN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const tz = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return (
    `You are opencode, the Telegram assistant for the user\'s Mac, running on ${getOpencodeModelLabel()} and wired into the opencode CLI. ` +
    'The bot HAS real abilities: it executes shell commands (via /execute, /bash, /exec and its agentic opencode path), reads/searches/lists files, and acts as a coding agent. ' +
    'Never claim you cannot execute shell commands, read files, or use tools - the bot can. ' +
    'If you cannot run a tool yourself in this response, still do not say the bot is incapable: tell the user to use the relevant slash command (e.g. /execute <command>) or that the command is being run. ' +
    `The bot exposes ${getRegisteredCommands().size} slash commands; list them with /help. ` +
    'Answer helpfully and concisely. Answer only the latest message against the visible transcript: ' +
    'never claim something arrived (a file, voice note, screenshot, result) unless its content is right there in the transcript. ' +
    'If the user refers to something sent that you cannot see, say you do not see it and ask for a resend — do not reconstruct it from earlier turns. ' +
    'Do not narrate a plan before answering; answer once. ' +
    `The current local date and time is: ${dateTime} (UTC${tz}).`
  );
}

function cannedResponse(message: string): string | null {
  const responses: Record<string, string> = {
    hello: 'Hello! I\'m your opencode bot. I can help you with various tasks.',
    hi: 'Hi there! How can I assist you?',
    help: 'I can execute terminal commands, read files, search for patterns, and more. Try /help to see all commands.',
    'who are you': `I'm opencode, a Telegram bot running on ${getOpencodeModelLabel()}.`,
    'what can you do': 'I can run terminal commands, read files, search files, list directories, and respond to your messages.',
  };
  const lowerMsg = message.toLowerCase();
  for (const [key, val] of Object.entries(responses)) {
    if (lowerMsg.includes(key)) {
      return val;
    }
  }
  // No canned match: return null so the caller reports the real outage
  // instead of parroting the user's message back as an echo.
  return null;
}

function cleanFences(text: string): string {
  return text
    .replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

function truncate(text: string, max = 4000): string {
  return text.length > max ? text.slice(0, max) + '\n\n…(truncated)' : text;
}

async function runAgenticViaClient(message: string, user: string): Promise<string> {
  const directory = opencodeDirectory || OPENCODE_CWD;
  let sessionId = opencodeSessionIds.get(user);
  if (!sessionId) {
    const session = await opencodeClient.session.create({
      body: { title: `telegram:${new Date().toISOString()}` },
      query: { directory },
    });
    // The SDK client returns { data, error, request, response } envelopes, so the
    // session id may be at session.data.id; accept both shapes for robustness.
    sessionId = session?.data?.id ?? session?.id;
    if (!sessionId) {
      throw new Error('opencode client session create returned no session id');
    }
    opencodeSessionIds.set(user, sessionId);
    while (opencodeSessionIds.size > 50) {
      const oldest = opencodeSessionIds.keys().next();
      if (oldest.done) break;
      opencodeSessionIds.delete(oldest.value);
    }
  }
  try {
  const response = await Promise.race([
    opencodeClient.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text: message }] },
      query: { directory },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        opencodeClient.session.abort({ path: { id: sessionId }, query: { directory } }).catch(() => {});
        reject(new Error(`opencode client prompt timed out after ${OPENCODE_TIMEOUT_MS}ms`));
      }, OPENCODE_TIMEOUT_MS),
    ),
  ]);
  const parts = response?.data?.parts ?? response?.parts ?? [];
  const text = parts
    .filter((p: any) => p.type === 'text' && !p.synthetic && !p.ignored)
    .map((p: any) => p.text)
    .join('\n')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .trim();
  if (!text) {
    throw new Error('opencode client prompt produced no text');
  }
  return cleanFences(text);
  } catch (error) {
    // Session may be dead (e.g. timed out); drop it so the next call starts fresh.
    opencodeSessionIds.delete(user);
    throw error;
  }
}

async function deleteClientSession(sessionId: string, directory: string): Promise<void> {
  if (!opencodeClient || !sessionId) return;
  // Best-effort cleanup across SDK shapes; a failed delete must never fail
  // the digest — the session simply lingers like before.
  const attempts: (() => Promise<unknown>)[] = [];
  const s = opencodeClient.session as any;
  if (s?.delete) attempts.push(() => s.delete({ path: { id: sessionId }, query: { directory } }));
  if (s?.remove) attempts.push(() => s.remove({ path: { id: sessionId }, query: { directory } }));
  if (opencodeClient?.deleteSession) attempts.push(() => opencodeClient.deleteSession(sessionId));
  for (const fn of attempts) {
    try {
      await fn();
      return;
    } catch { /* try next shape */ }
  }
}

// Digest-only path: each briefing runs in a FRESH session that is deleted
// afterwards, so daily digests never accumulate in the opencode CLI session
// list. Never reuses or stores the id in opencodeSessionIds. Telegram
// delivery happens in digest.ts via sendTextToChat; nothing here prints.
export async function runDigestAgentic(fullPrompt: string): Promise<string> {
  if (opencodeV2) {
    // Fresh session per digest, removed afterwards so briefings never pile up
    // in the session list. The digest agent denies every tool, as in V1.
    const created = await opencodeV2.session.create({
      title: `telegram-digest-ephemeral:${new Date().toISOString()}`,
    });
    const sessionId = v2SessionIdOf(created);
    if (!sessionId) {
      throw new Error('opencode v2 session create returned no session id');
    }
    try {
      await Promise.race([
        opencodeV2.session.prompt({ sessionID: sessionId, text: fullPrompt, agent: 'digest' }),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            Promise.resolve(opencodeV2.session.interrupt({ sessionID: sessionId })).catch(() => {});
            reject(new Error(`digest prompt timed out after ${OPENCODE_TIMEOUT_MS}ms`));
          }, OPENCODE_TIMEOUT_MS),
        ),
      ]);
      if (typeof opencodeV2.session.wait === 'function') {
        await opencodeV2.session.wait({ sessionID: sessionId });
      }
      const messages = await opencodeV2.session.context({ sessionID: sessionId });
      const text = v2TextFromMessages(messages);
      if (!text) {
        throw new Error('digest agent produced no text');
      }
      return cleanFences(text);
    } finally {
      if (typeof opencodeV2.session.remove === 'function') {
        Promise.resolve(opencodeV2.session.remove({ sessionID: sessionId })).catch(() => {});
      }
    }
  }

  if (!opencodeClient) {
    // Standalone mode: fall back to the subprocess path (no persistent
    // session is created there either).
    return runOpencodeAgentic(fullPrompt, 'digest-ephemeral', fullPrompt, '');
  }
  const directory = opencodeDirectory || OPENCODE_CWD;
  const created = await opencodeClient.session.create({
    body: { title: `telegram-digest-ephemeral:${new Date().toISOString()}` },
    query: { directory },
  });
  const sessionId = created?.data?.id ?? created?.id;
  if (!sessionId) {
    throw new Error('opencode client session create returned no session id');
  }
  try {
    const response = await Promise.race([
      opencodeClient.session.prompt({
        path: { id: sessionId },
        // The "digest" agent (~/.config/opencode/agent/digest.md) has every tool denied:
        // it only writes the digest from the data in the prompt, so a poisoned news item
        // can't make it run shell commands, touch files or browse.
        body: { agent: 'digest', parts: [{ type: 'text', text: fullPrompt }] },
        query: { directory },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          opencodeClient.session.abort({ path: { id: sessionId }, query: { directory } }).catch(() => {});
          reject(new Error(`digest prompt timed out after ${OPENCODE_TIMEOUT_MS}ms`));
        }, OPENCODE_TIMEOUT_MS),
      ),
    ]);
    const parts = response?.data?.parts ?? response?.parts ?? [];
    const text = parts
      .filter((p: any) => p.type === 'text' && !p.synthetic && !p.ignored)
      .map((p: any) => p.text)
      .join('\n')
      .replace(/\x1b\[[0-9;]*m/g, '')
      .trim();
    if (!text) {
      throw new Error('digest prompt produced no text');
    }
    return cleanFences(text);
  } finally {
    await deleteClientSession(sessionId, directory);
  }
}

export async function runOpencodeAgentic(fullPrompt: string, user: string, latestMessage: string, prelude = ''): Promise<string> {
  if (opencodeV2) {
    // V2 sessions keep their own history, same as the V1 client path.
    const turnPrompt = [prelude, latestMessage].filter(Boolean).join('\n\n');
    return await runAgenticViaV2(turnPrompt, user);
  }

  if (opencodeClient) {
    // The SDK session keeps its own history, so send the latest message plus
    // the current goal/steer/focus prelude (no transcript duplication).
    const turnPrompt = [prelude, latestMessage].filter(Boolean).join('\n\n');
    return await runAgenticViaClient(turnPrompt, user);
  }

  const args = ['run', fullPrompt, '--log-level', 'ERROR', '--auto'];
  const liveModel = getOpencodeModel();
  if (liveModel) {
    args.splice(2, 0, '--model', liveModel);
  }
  // Run inside the user's ACTIVE project (phone != bot workspace), and with
  // the bot guardrail config layered in when the user hasn't pinned their own
  // OPENCODE_CONFIG (explicit user config always wins).
  const projectDir = getActiveProject(user);
  args.push('--dir', projectDir);
  const botConfig = ensureBotConfig();
  const child = spawn(OPENCODE_BIN, args, {
    cwd: OPENCODE_CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', ...(botConfig ? { OPENCODE_CONFIG: botConfig } : {}) },
  });
  currentChild = child;

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`opencode run timed out after ${OPENCODE_TIMEOUT_MS}ms`));
    }, OPENCODE_TIMEOUT_MS),
  );

  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        // code null = killed by signal (/stop SIGKILL). Report cancellation,
        // not failure — the caller swallows this into a quiet "Stopped".
        if (code === null) {
          reject(Object.assign(new Error('agentic run stopped by user'), { cancelled: true }));
        } else {
          reject(new Error(`opencode run exited with code ${code}: ${stderr.trim()}`));
        }
      } else {
        resolve();
      }
    });
  });

  try {
    await Promise.race([exited, timeout]);
  } finally {
    if (currentChild === child) currentChild = null;
  }

  const text = cleanFences(stdout.replace(/\x1b\[[0-9;]*m/g, ''));
  if (!text) {
    throw new Error('opencode run produced no output');
  }
  return text;
}

export async function handleAiMessage(user: string, message: string): Promise<string | null> {
  console.log(`AI Handler: User ${user} said: "${message}"`);

  // No front-gate guessing: every message goes to the model like openclaw.
  // Explicit slash commands (/execute, /read, ...) still dispatch through
  // the command layer; nothing here interprets plain text as commands.
  if (!message.trim()) {
    return null;
  }

  // Remember this turn so follow-up messages have context.
  appendMessage(user, 'user', message);
  const history = getHistory(user);
  const transcript = formatTranscript(history);

  let agentFallback: 'none' | 'error' | 'incomplete' = 'none';
  let lastError = '';
  if (ALLOWED_USERS.includes(user)) {
    // Every conversational message goes through the opencode path on
    // OPENCODE_MODEL env. The old short-chat
    // bypass to the local llama endpoint is removed: llama is not required
    // and a dead endpoint produced parroted "I heard you say" fallbacks.
    {
      console.log('Routing conversational message via opencode run');
      const state = getAgentState();
      const prelude = [
        OPERATOR_CHARTER,
        AGENT_HARDENING_INSTRUCTION,
        state.goal ? `Ongoing goal: ${state.goal}` : '',
        state.steer ? `Steering: ${state.steer}` : '',
        state.focus ? 'Focus mode is ON: stay tightly on task, no tangential exploration.' : '',
        state.prose ? 'Write in flowing prose.' : '',
        state.fast ? 'Fast mode is ON: keep responses brief.' : '',
      ]
        .filter(Boolean)
        .join('\n');
      // opencode run is stateless per invocation, so inject the recent
      // transcript and ask it to continue the conversation.
      const transcriptPrompt = transcript
        ? `${transcript}\n\nContinue the conversation. Respond to the user's latest message.`
        : message;
      const agentPrompt = [prelude, transcriptPrompt].filter(Boolean).join('\n\n');
      // One retry on network-class failures (Tailscale/DNS blips): a brief
      // outage should not instantly become a user-visible failure. Retry
      // once after 10s; anything else fails fast to the honest error below.
      const NETWORK_RE = /timed out|fetch failed|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EADDRNOTAVAIL|ENOTFOUND|network/i;
      const runOnce = () => enqueueRun(() => runOpencodeAgentic(agentPrompt, user, message, prelude));
      const queued = (async () => {
        try {
          return await runOnce();
        } catch (e: any) {
          if (!NETWORK_RE.test(e.message || '')) throw e;
          console.error('opencode run hit a network blip; retrying once in 10s:', e.message);
          await new Promise((r) => setTimeout(r, 10000));
          return await runOnce();
        }
      })();
      try {
        let agentic = await queued;
        if (isUnfulfilledPromise(agentic)) {
          console.error('Agent response is intent-only; retrying with hardening nudge.');
          const hardened = agentPrompt + '\n\n' + AGENT_HARDENING_INSTRUCTION + '\n' + RETRY_NUDGE;
          agentic = await enqueueRun(() => runOpencodeAgentic(hardened, user, message, prelude));
        }
        if (isUnfulfilledPromise(agentic)) {
          console.error('Agent still intent-only after retry; reporting failure honestly.');
          agentFallback = 'incomplete';
        } else {
          appendMessage(user, 'assistant', agentic);
          console.log(`AI Response (opencode): ${agentic}`);
          return truncate(agentic);
        }
      } catch (error: any) {
        if (error?.cancelled) {
          console.log('Agentic run cancelled by /stop — no reply sent.');
          return 'Stopped — run cancelled, nothing sent.';
        }
        console.error('opencode run failed:', error.message);
        agentFallback = 'error';
        lastError = error.message;
      }
    }
  } else {
    console.log(`User ${user} not in allowed list; no model path (strangers get canned replies only)`);
    const canned = cannedResponse(message);
    if (canned !== null) {
      return canned;
    }
    return 'Not authorized.';
  }

  // No dead-model fallback chain: when the opencode run fails, say so
  // plainly instead of dropping to a local endpoint that is not running.
  const msg =
    agentFallback === 'incomplete'
      ? 'I started on that but could not complete it just now. Try again in a bit, or send /execute <command> to run shell directly.'
      : `My model run failed just now (${getOpencodeModelLabel()}${lastError ? `: ${lastError}` : ''}). Try again in a bit — this is usually a brief network blip, not a bot problem.`;
  appendMessage(user, 'assistant', msg);
  return msg;
}

setAiHandler(handleAiMessage);

