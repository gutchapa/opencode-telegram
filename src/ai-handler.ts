import { spawn } from 'child_process';
import { setAiHandler, getRegisteredCommands } from './sdk/plugin-runtime';
import { getAgentState } from './agent-state';
import { appendMessage, getHistory, formatTranscript, HistoryEntry } from './conversation-memory';
import { runShell } from './shell';

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

const SHELL_COMMANDS = new Set([
  'ls','pwd','cd','cat','echo','printf','whoami','id','groups','uname','sw_vers','hostname','date','cal',
  'df','du','ps','top','kill','sleep','uptime','env','export','which','type','command','file','stat','readlink',
  'head','tail','wc','sort','uniq','cut','tr','grep','egrep','fgrep','sed','awk','find','locate','mdfind','xargs',
  'mkdir','rmdir','rm','cp','mv','touch','chmod','chown','chgrp','ln','readlink','open','defaults','plutil',
  'tar','gzip','gunzip','zip','unzip','base64','shasum','md5','cksum','dd',
  'curl','wget','ping','traceroute','dig','nslookup','nc','netstat','lsof','ifconfig','scutil','route','arp',
  'brew','npm','npx','node','python3','python','pip3','pip','git','svn','hg','make','cmake','xcodebuild','swift',
  'docker','kubectl','sqlite3','osascript','say','afplay','sips','ffmpeg','jq','yq','sh','bash','zsh','sudo',
  'system_profiler','diskutil','ioreg','systemsetup','networksetup','security','dscl','launchctl','launchd',
  'killall','pkill','wait','tee','fold','paste','join','comm','nl','od','xxd','hexdump','strings','diff','cmp',
  'patch','rsync','scp','ssh','sftp','ftp','telnet','ruby','perl','php','go','rustc','cargo',
  'watch','duf','broot','eza','exa','bat','fd','rg','ag','ack','delta','zoxide','fzf',
]);

const QUESTION_RE = /^(how|what|why|when|which|who|whom|whose|where|is|are|was|were|can|could|should|would|will|does|did)\b/i;
const SHELL_STRONG_RE = /\b(try|run|execute|exec|show|print)\b/i;
const SHELL_WEAK_RE = /\b(use|please|now|just|do|go ahead|let'?s)\b/i;
const SHELL_FILLER = /^(me|the|a|an|us|out)$/i;

const TASK_RE = /\b(check|install|run|execut|show|list|find|creat|mak|build|test|anal|writ|read|open|search|updat|remov|delet|copy|move|download|curl|clone|start|stop|restart|status|debug|fix|setup|config|generate|explain)\b/i;

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
  'or just say it plainly, e.g. "try npm install -g wispr".\n\n' +
  "(The opencode agent was still working on your message and timed out, so this reply comes from the fallback model.)";

export function isInabilityClaim(response: string): boolean {
  return INABILITY_RE.some((re) => re.test(response));
}

function extractShellCommand(message: string): string | null {
  const text = message.trim();
  if (!text || text.length > 500) return null;
  const tokens = text.split(/\s+/);
  const clean = (t: string) => t.replace(/^[^a-zA-Z0-9_./~-]+/, '').toLowerCase();
  let idx = -1;
  if (SHELL_COMMANDS.has(clean(tokens[0]))) {
    idx = 0;
  } else {
    const isQuestion = QUESTION_RE.test(text);
    for (let i = 0; i < tokens.length; i++) {
      const strong = SHELL_STRONG_RE.test(tokens[i]);
      const weak = SHELL_WEAK_RE.test(tokens[i]);
      if (!(strong || (weak && !isQuestion))) continue;
      let j = i + 1;
      if (j < tokens.length && SHELL_FILLER.test(clean(tokens[j]))) j++;
      if (j < tokens.length && SHELL_COMMANDS.has(clean(tokens[j]))) {
        idx = j;
        break;
      }
      if (strong) break;
    }
  }
  if (idx === -1) return null;
  let cmd = tokens.slice(idx).join(' ');
  const cutAt = cmd.search(
    /\s+(command|output|result|results|here|please|now|thanks|for me|to telegram|in telegram|to terminal|on terminal|in terminal|your terminal|the terminal|and then|then|and show|show me|and print)\b/i
  );
  if (cutAt !== -1) cmd = cmd.slice(0, cutAt);
  cmd = cmd.replace(/[,.…\s]+$/g, '').trim();
  if (!cmd || cmd.length > 200) return null;
  return cmd;
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
    'You are opencode, the Telegram assistant for the user\'s Mac, running locally via llama.cpp (Qwen) and wired into the opencode CLI. ' +
    'The bot HAS real abilities: it executes shell commands (via /execute, /bash, /exec and its agentic opencode path), reads/searches/lists files, and acts as a coding agent. ' +
    'Never claim you cannot execute shell commands, read files, or use tools - the bot can. ' +
    'If you cannot run a tool yourself in this response, still do not say the bot is incapable: tell the user to use the relevant slash command (e.g. /execute <command>) or that the command is being run. ' +
    `The bot exposes ${getRegisteredCommands().size} slash commands; list them with /help. ` +
    'Answer helpfully and concisely. ' +
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

async function callQwenDirect(message: string, history: HistoryEntry[] = []): Promise<string> {
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
          ...(history.length
            ? history.map((e) => ({ role: e.role, content: e.content }))
            : [{ role: 'user' as const, content: message }]),
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

  const child = spawn(OPENCODE_BIN, ['run', fullPrompt, '--log-level', 'ERROR', '--auto'], {
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

  // Remember this turn so follow-up messages have context.
  appendMessage(user, 'user', message);
  const history = getHistory(user);
  const transcript = formatTranscript(history);

  if (ALLOWED_USERS.includes(user)) {
    const shellCmd = extractShellCommand(message);
    if (shellCmd) {
      try {
        const output = await runShell(shellCmd);
        const result = `$ ${shellCmd}\n${output}`;
        appendMessage(user, 'assistant', result);
        console.log(`AI Response (shell): ${result}`);
        return truncate(result);
      } catch (error: any) {
        console.error('Shell command failed:', error.message);
        const msg = `Shell command failed: ${error.message}`;
        appendMessage(user, 'assistant', msg);
        return msg;
      }
    }
    const isShortChat = message.trim().length <= 80 && !TASK_RE.test(message);
    if (isShortChat) {
      console.log('Short conversational message; skipping opencode run (direct model)');
    } else {
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
      // opencode run is stateless per invocation, so inject the recent
      // transcript and ask it to continue the conversation.
      const transcriptPrompt = transcript
        ? `${transcript}\n\nContinue the conversation. Respond to the user's latest message.`
        : message;
      const agentPrompt = [prelude, transcriptPrompt].filter(Boolean).join('\n\n');
      const queued = agenticQueue.then(() => runOpencodeAgentic(agentPrompt, user, message, prelude));
      agenticQueue = queued.then(() => null, () => null);
      try {
        const agentic = await queued;
        appendMessage(user, 'assistant', agentic);
        console.log(`AI Response (opencode): ${agentic}`);
        return truncate(agentic);
      } catch (error: any) {
        console.error('opencode run failed, falling back to direct Qwen:', error.message);
      }
    }
  } else {
    console.log(`User ${user} not in allowed list; direct Qwen only (no tools)`);
  }

  try {
    let response = await callQwenDirect(message, history);
    if (isInabilityClaim(response)) {
      console.error('Qwen response claimed inability; replacing with truthful fallback.');
      response = INABILITY_FALLBACK;
    }
    appendMessage(user, 'assistant', response);
    console.log(`AI Response (qwen): ${response}`);
    return truncate(response);
  } catch (error: any) {
    console.error('Direct Qwen failed, using canned fallback:', error.message);
    const fallback = cannedResponse(message);
    return fallback;
  }
}

setAiHandler(handleAiMessage);

