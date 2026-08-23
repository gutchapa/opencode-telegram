import { spawn } from 'child_process';
import { setAiHandler, getRegisteredCommands } from './sdk/plugin-runtime';
import { getAgentState } from './agent-state';

const OPENCODE_BIN = process.env.OPENCODE_BIN || '/Users/gutchapa/.local/bin/opencode';
const OPENCODE_CWD = process.env.OPENCODE_CWD || '/Users/gutchapa/.opencode-bot-ws';
const OPENCODE_TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT_MS || 180000);

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'http://127.0.0.1:8095/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen3.5-9b';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 60000);

const ALLOWED_USERS = (process.env.ALLOWED_TELEGRAM_USERS || '791865934')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let agenticQueue: Promise<string | null> = Promise.resolve(null);

// In-process opencode SDK client, injected when this package runs as an opencode
// server plugin. When set, agentic replies run against the hosting server instead
// of spawning a nested `opencode run` process.
let opencodeClient: any = null;
let opencodeDirectory: string | undefined;

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
    'You are opencode, a local AI assistant running on the user\'s Mac via llama.cpp (Qwen). ' +
    'Answer helpfully and concisely. You have no internet access. ' +
    `The current local date and time is: ${dateTime} (UTC${tz}).`
  );
}

function cannedResponse(message: string): string {
  const responses: Record<string, string> = {
    hello: 'Hello! I\'m your opencode bot. I can help you with various tasks.',
    hi: 'Hi there! How can I assist you?',
    help: 'I can execute terminal commands, read files, search for patterns, and more. Try /help to see all commands.',
    'who are you': 'I\'m opencode, a local AI-powered Telegram bot that runs on Qwen.',
    'what can you do': 'I can run terminal commands, read files, search files, list directories, and respond to your messages.',
  };
  const lowerMsg = message.toLowerCase();
  for (const [key, val] of Object.entries(responses)) {
    if (lowerMsg.includes(key)) {
      return val;
    }
  }
  return 'I heard you say: ' + message + '. How can I help you with that?';
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

async function callQwenDirect(message: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(LLM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: getAgentState().model || LLM_MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: message },
        ],
        max_tokens: 512,
        temperature: 0.7,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`LLM endpoint returned HTTP ${res.status}`);
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

async function runAgenticViaClient(message: string): Promise<string> {
  const directory = opencodeDirectory || OPENCODE_CWD;
  const session = await opencodeClient.session.create({
    body: { title: `telegram:${new Date().toISOString()}` },
    query: { directory },
  });
  // The SDK client returns { data, error, request, response } envelopes, so the
  // session id may be at session.data.id; accept both shapes for robustness.
  const sessionId = session?.data?.id ?? session?.id;
  if (!sessionId) {
    throw new Error('opencode client session create returned no session id');
  }
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
}

async function runOpencodeAgentic(message: string): Promise<string> {
  if (opencodeClient) {
    return await runAgenticViaClient(message);
  }

  const child = spawn(OPENCODE_BIN, ['run', message, '--log-level', 'ERROR', '--auto'], {
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

  const commandIntent = /\b(how|what|usage|explain|use|help|mean)\b/i.test(message);
  const slashToken = message.match(/\/([a-z][a-z0-9_-]{1,31})\b/i);
  if (commandIntent && slashToken) {
    const entry = getRegisteredCommands().get(slashToken[1].toLowerCase());
    if (entry) {
      const result = await entry.handler(user, entry.command, '');
      if (result) {
        console.log(`AI Response (command usage): ${result}`);
        return truncate(result);
      }
    }
  }

  if (!message.trim()) {
    return null;
  }

  if (ALLOWED_USERS.includes(user)) {
    const state = getAgentState();
    const prelude = [
      state.goal ? `Ongoing goal: ${state.goal}` : '',
      state.steer ? `Steering: ${state.steer}` : '',
      state.focus ? 'Focus mode is ON: stay tightly on task, no tangential exploration.' : '',
      state.prose ? 'Write in flowing prose.' : '',
      state.fast ? 'Fast mode is ON: keep responses brief.' : '',
    ]
      .filter(Boolean)
      .join('\n');
    const agentPrompt = prelude ? `${prelude}\n\n${message}` : message;
    const queued = agenticQueue.then(() => runOpencodeAgentic(agentPrompt));
    agenticQueue = queued.then(() => null, () => null);
    try {
      const agentic = await queued;
      console.log(`AI Response (opencode): ${agentic}`);
      return truncate(agentic);
    } catch (error: any) {
      console.error('opencode run failed, falling back to direct Qwen:', error.message);
    }
  } else {
    console.log(`User ${user} not in allowed list; direct Qwen only (no tools)`);
  }

  try {
    const response = await callQwenDirect(message);
    console.log(`AI Response (qwen): ${response}`);
    return truncate(response);
  } catch (error: any) {
    console.error('Direct Qwen failed, using canned fallback:', error.message);
    const fallback = cannedResponse(message);
    return fallback;
  }
}

setAiHandler(handleAiMessage);
