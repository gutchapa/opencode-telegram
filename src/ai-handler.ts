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
// bot's opencode config defines. Nothing is hardcoded here.
const OPENCODE_MODEL = (process.env.OPENCODE_MODEL || '').trim();
const OPENCODE_MODEL_LABEL = OPENCODE_MODEL || "this bot's opencode-config default";

const AGENT_HARDENING_INSTRUCTION =
  'Do the task NOW using your tools (read, grep, ls, bash) and report the concrete result. ' +
  'Never end with only intent such as "Let me read that file" or "I will check" - actually do it in this turn.';
const RETRY_NUDGE =
  'Your previous reply only promised to do the task instead of doing it. ' +
  'This time you MUST actually do the work with your tools and give the concrete result.';

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'http://127.0.0.1:8095/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen3.5-9b';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 60000);

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

const INABILITY_RE = [
  /i (?:haven'?t been able to|am unable to|am not able to|cannot|can'?t|don'?t have|do not have|lack) (?:the )?(?:ability|permission|access|tools?|means?)? ?(?:to )?(?:execute|run|access|open|use)/i,
  /i can only (?:generate|provide|output|create) text/i,
  /i (?:cannot|can'?t) (?:execute|run) (?:shell )?(?:commands?|code)/i,
  /(?:you|please|you'?ll need to) (?:can )?(?:run|execute|paste|copy)[^.]*these commands?/i,
  /i'?m (?:just|only) a (?:text|language|chat) model/i,
  /no (?:shell|terminal|command[ -]line|filesystem) access/i,
  /i (?:don'?t|do not) (?:have|possess) (?:shell|terminal|command[ -]line|filesystem|tool)/i,
  /i have no (?:ability|way|access|permission)/i,
  /these commands? (?:into|in|to) your/i,
  /in your (?:own )?terminal/i,
];

const INABILITY_FALLBACK =
  "I can run that for you - commands execute on this Mac and the output comes back right here in Telegram.\n" +
  "Send me: /execute <command>\n" +
  'e.g. "/execute npm install -g wispr".';

const FAKE_ACTION_RE = /\b(?:i'?ll|i will|we'?ll|we will|let me|i'?m going to|i'?m about to|ok,? i'?ll|now i'?ll|i'?m on it)\s+(?:now\s+|just\s+|try (?:to|and)\s+|attempt (?:to|at)\s+|go ahead and\s+|please\s+|continue (?:to|with)\s+)?(?:install|run|execute|check|verify|fix|set up|download|build|create|write|open|start|stop|deploy|update|remove|delete|test|try|restart|clone|configure|generate|continue|proceed|finish|investigate|attempt)\b/i;
const FAKE_ACTION_GERUND_RE = /\b(?:i'?m|i am|we'?re|we are)(?:\s+(?:on it|now|just|currently|about to))?\s*[-–:]?\s*(?:installing|running|executing|checking|verifying|fixing|setting up|downloading|building|creating|writing|opening|starting|stopping|deploying|updating|removing|deleting|testing|restarting|cloning|configuring|generating|continuing|proceeding|finishing|investigating|attempting|trying)\b/i;

const TASK_FALLBACK =
  "The opencode agent was working on that task but timed out, so this reply comes from the fallback model - which can't run commands itself.\n" +
  'To run it directly: send /execute <command> (e.g. /execute npm install -g wispr).';

const INCOMPLETE_TASK_FALLBACK =
  "The opencode agent started that task but only said it would do it (e.g. \"Let me read that file\") without actually doing it, so this reply comes from the fallback model - which can't run commands itself.\n" +
  'To run it directly: send /execute <command>, or just say it plainly, e.g. "read the file for me".';

export function isInabilityClaim(response: string): boolean {
  return INABILITY_RE.some((re) => re.test(response));
}

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
    `You are opencode, the Telegram assistant for the user\'s Mac, running on ${OPENCODE_MODEL_LABEL} and wired into the opencode CLI. ` +
    'The bot HAS real abilities: it executes shell commands (via /execute, /bash, /exec and its agentic opencode path), reads/searches/lists files, and acts as a coding agent. ' +
    'Never claim you cannot execute shell commands, read files, or use tools - the bot can. ' +
    'If you cannot run a tool yourself in this response, still do not say the bot is incapable: tell the user to use the relevant slash command (e.g. /execute <command>) or that the command is being run. ' +
    `The bot exposes ${getRegisteredCommands().size} slash commands; list them with /help. ` +
    'Answer helpfully and concisely. ' +
    `The current local date and time is: ${dateTime} (UTC${tz}).`
  );
}

function cannedResponse(message: string): string | null {
  const responses: Record<string, string> = {
    hello: 'Hello! I\'m your opencode bot. I can help you with various tasks.',
    hi: 'Hi there! How can I assist you?',
    help: 'I can execute terminal commands, read files, search for patterns, and more. Try /help to see all commands.',
    'who are you': `I'm opencode, a Telegram bot running on ${OPENCODE_MODEL_LABEL}.`,
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

function extractAnswer(content: string): string {
  const answerMatch = content.match(/<answer>([\s\S]*?)<\/answer>/);
  if (answerMatch) {
    return answerMatch[1].trim();
  }
  return content.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
}

function truncate(text: string, max = 4000): string {
  return text.length > max ? text.slice(0, max) + '\n\n…(truncated)' : text;
}

interface ChatCompletionChoice {
  message?: {
    content?: string;
    reasoning_content?: string;
  };
}
interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

async function callQwenDirect(message: string, history: HistoryEntry[] = []): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    // Sanitize history before sending: a malformed or empty entry used to produce
    // HTTP 400 from the local LLM. Keep only valid roles with non-empty content,
    // and cap the prompt so it stays well under the server's context window.
    const safeHistory = (history || [])
      .filter(
        (e) =>
          e &&
          (e.role === 'user' || e.role === 'assistant') &&
          typeof e.content === 'string' &&
          e.content.trim().length > 0,
      )
      .slice(-20)
      .map((e) => ({ role: e.role, content: e.content.trim() }));
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: buildSystemPrompt() },
      ...(safeHistory.length
        ? safeHistory
        : [{ role: 'user', content: message }]),
    ];
    const MAX_PROMPT_CHARS = 12000;
    let total = messages.reduce((n, m) => n + m.content.length, 0);
    while (total > MAX_PROMPT_CHARS && messages.length > 2) {
      total -= messages.splice(1, 1)[0].content.length;
    }

    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(LLM_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: getAgentState().model || LLM_MODEL,
          messages,
          max_tokens: 512,
          temperature: 0.7,
          stream: false,
        }),
        signal: controller.signal,
      });
      const transient = res.status === 429 || (res.status >= 500 && res.status <= 599);
      if (res.ok || !transient || attempt >= 1) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!res.ok) {
      let bodyText = '';
      try {
        bodyText = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      throw new Error(`LLM endpoint returned HTTP ${res.status}: ${bodyText}`);
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const choice = data?.choices?.[0];
    let content: string = choice?.message?.content ?? '';
    if (!content) {
      content = choice?.message?.reasoning_content ?? '';
    }
    const answer = extractAnswer(content);
    if (!answer) {
      throw new Error('Empty LLM response');
    }
    return answer;
  } finally {
    clearTimeout(timer);
  }
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
  if (OPENCODE_MODEL) {
    args.splice(2, 0, '--model', OPENCODE_MODEL);
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

  let fellBackFromTask = false;
  let agentFallback: 'none' | 'error' | 'incomplete' = 'none';
  if (ALLOWED_USERS.includes(user)) {
    // Every conversational message goes through the opencode path on
    // OPENCODE_MODEL (Muse Spark via OpenCode Zen). The old short-chat
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
      const queued = agenticQueue.then(() => runOpencodeAgentic(agentPrompt, user, message, prelude));
      agenticQueue = queued.then(() => null, () => null);
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
          console.error('Agent still intent-only after retry; falling back to direct Qwen.');
          agentFallback = 'incomplete';
        } else {
          appendMessage(user, 'assistant', agentic);
          console.log(`AI Response (opencode): ${agentic}`);
          return truncate(agentic);
        }
      } catch (error: any) {
        console.error('opencode run failed, falling back to direct Qwen:', error.message);
        agentFallback = 'error';
        fellBackFromTask = true;
      }
    }
  } else {
    console.log(`User ${user} not in allowed list; direct Qwen only (no tools)`);
  }

  try {
    let response = await callQwenDirect(message, history);
    if (
      isInabilityClaim(response) ||
      FAKE_ACTION_RE.test(response) ||
      FAKE_ACTION_GERUND_RE.test(response) ||
      isUnfulfilledPromise(response)
    ) {
      console.error('Qwen fallback was untruthful; replacing with truthful fallback.');
      response = agentFallback === 'incomplete' ? INCOMPLETE_TASK_FALLBACK : fellBackFromTask ? TASK_FALLBACK : INABILITY_FALLBACK;
    }
    appendMessage(user, 'assistant', response);
    console.log(`AI Response (qwen): ${response}`);
    return truncate(response);
  } catch (error: any) {
    console.error('Direct Qwen failed, using canned fallback:', error.message);
    const canned = cannedResponse(message);
    // cannedResponse returns null when there is no canned match: never parrot
    // the user's message back as an "I heard you say" echo. Tell the truth
    // about the outage instead, with the endpoint so it can be debugged.
    if (canned !== null) {
      return canned;
    }
    const msg =
      'I cannot reach my language model right now ' +
      `(${LLM_ENDPOINT} unreachable: ${error.message}). ` +
      'Start the local model server and try again, or use /execute for shell commands.';
    appendMessage(user, 'assistant', msg);
    return msg;
  }
}

setAiHandler(handleAiMessage);

