import { spawn } from 'child_process';
import { setAiHandler, getRegisteredCommands } from './sdk/plugin-runtime';
import { getAgentState } from './agent-state';
import { appendMessage, getHistory, formatTranscript, HistoryEntry } from './conversation-memory';

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
  'Do the task NOW using your tools (read, grep, ls, bash) and report the concrete result. ' +
  'Never end with only intent such as "Let me read that file" or "I will check" - actually do it in this turn.';
const RETRY_NUDGE =
  'Your previous reply only promised to do the task instead of doing it. ' +
  'This time you MUST actually do the work with your tools and give the concrete result.';

const ALLOWED_USERS = (process.env.ALLOWED_TELEGRAM_USERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let agenticQueue: Promise<string | null> = Promise.resolve(null);

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
// Reuse one opencode session per chat so the SDK path keeps real multi-turn context.
const opencodeSessionIds = new Map<string, string>();

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

async function runOpencodeAgentic(fullPrompt: string, user: string, latestMessage: string, prelude = ''): Promise<string> {
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
  const child = spawn(OPENCODE_BIN, args, {
    cwd: OPENCODE_CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  });

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
        reject(new Error(`opencode run exited with code ${code}: ${stderr.trim()}`));
      } else {
        resolve();
      }
    });
  });

  await Promise.race([exited, timeout]);

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
      const runOnce = () => {
        const q = agenticQueue.then(() => runOpencodeAgentic(agentPrompt, user, message, prelude));
        agenticQueue = q.then(() => null, () => null);
        return q;
      };
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
          const retried = agenticQueue.then(() => runOpencodeAgentic(hardened, user, message, prelude));
          agenticQueue = retried.then(() => null, () => null);
          agentic = await retried;
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

