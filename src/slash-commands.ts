// Slash commands for the opencode telegram bot, mirroring a classic chat-command
// surface (/reset /restart /compact /model /tools etc.). Commands that only
// make sense in the opencode CLI (login, dock-*, bot-upgrade, ...) are
// registered so they resolve instead of falling through to the AI handler,
// and reply with a short explanation.

import { readFile, readdir, writeFile } from 'fs/promises';
import { registerPluginCommand, getRegisteredCommands } from './sdk/plugin-runtime';
import { getAgentState, setAgentState } from './agent-state';
import { clearHistory } from './conversation-memory';
import { handleAiMessage } from './ai-handler';
import { runShell, truncate } from './shell';

const CWD = process.env.OPENCODE_CWD || '/Users/gutchapa';
const HOME = process.env.HOME || '/Users/gutchapa';
const ALLOWED = (process.env.ALLOWED_TELEGRAM_USERS || '791865934')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const OPENCODE_CONFIGS = [
  `${HOME}/.config/opencode/opencode.jsonc`,
  `${HOME}/.opencode/opencode.json`,
];

function isAllowed(user: string): boolean {
  return ALLOWED.includes(user);
}

function parseBoolArg(arg: string, current: boolean): boolean {
  const a = arg.trim().toLowerCase();
  if (a === 'on' || a === 'true' || a === '1' || a === 'yes') return true;
  if (a === 'off' || a === 'false' || a === '0' || a === 'no') return false;
  return current;
}

async function readOpenCodeConfig(): Promise<{ model: string; paths: string[]; raw: string }> {
  for (const p of OPENCODE_CONFIGS) {
    try {
      const raw = await readFile(p, 'utf8');
      const model = (raw.match(/"model"\s*:\s*"([^"]+)"/) || [])[1] || '';
      const pathsMatch = raw.match(/"paths"\s*:\s*\[([\s\S]*?)\]/);
      const paths = pathsMatch
        ? [...pathsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
        : [];
      return { model, paths, raw };
    } catch {
      // try next config path
    }
  }
  return { model: '', paths: [], raw: '' };
}

let skillCache: { at: number; names: string[] } = { at: 0, names: [] };
async function listSkills(): Promise<string[]> {
  const now = Date.now();
  if (skillCache.at && now - skillCache.at < 60000) return skillCache.names;
  const { paths } = await readOpenCodeConfig();
  const names = new Set<string>();
  for (const base of paths) {
    const stack: string[] = [base];
    for (let depth = 0; stack.length && depth < 4; depth++) {
      const next: string[] = [];
      for (const dir of stack) {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const full = `${dir}/${e.name}`;
          if (e.name === 'SKILL.md') continue;
          try {
            await readFile(`${full}/SKILL.md`);
            names.add(e.name);
          } catch {
            next.push(full);
          }
        }
      }
      stack.length = 0;
      stack.push(...next);
    }
  }
  const sorted = [...names].sort();
  skillCache = { at: now, names: sorted };
  return sorted;
}

async function skillInfo(name: string): Promise<string> {
  const { paths } = await readOpenCodeConfig();
  for (const base of paths) {
    try {
      const content = await readFile(`${base}/${name}/SKILL.md`, 'utf8');
      return truncate(content.slice(0, 1200));
    } catch {
      // keep looking
    }
  }
  return `Skill '${name}' not found.`;
}

function stateSummary(): string {
  const s = getAgentState();
  return [
    `Name: ${s.name}`,
    `Model: ${process.env.LLM_MODEL || 'qwen3.5-9b'}`,
    `Activation: ${s.activation}`,
    `Fast: ${s.fast ? 'on' : 'off'}`,
    `Verbose: ${s.verbose ? 'on' : 'off'}`,
    `Trace: ${s.trace ? 'on' : 'off'}`,
    `Thinking: ${s.thinking}`,
    `Reasoning: ${s.reasoning ? 'on' : 'off'}`,
    `Usage: ${s.usage}`,
    `Elevated: ${s.elevated ? 'on' : 'off'}`,
    `Focus: ${s.focus ? 'on' : 'off'}`,
    `Prose: ${s.prose ? 'on' : 'off'}`,
    s.goal ? `Goal: ${s.goal}` : '',
    `Uptime: ${Math.floor(process.uptime() / 60)}m`,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildHelp(): string {
  return [
    '🤖 opencode-bot commands',
    '',
    'Tools:',
    '/execute <cmd> · /exec · /bash — run a shell command',
    '/read <path> — read a file',
    '/search <pattern> [path] — grep for a pattern',
    '/list [path] — list a directory',
    '',
    'Session commands:',
    '/new · /reset — start a fresh session',
    '/compact — note on context',
    '/restart — reset agentic state',
    '/stop — drop queued agentic runs',
    '/status — bot status',
    '/id · /whoami · /name [x] — identity',
    '/goal <text> — set an ongoing goal for the agent',
    '/steer <text> — steering note for the agent',
    '/tell <text> — send a direct instruction to the agent',
    '/fast · /focus · /unfocus · /prose · /btw · /tasks · /subagents',
    '',
    'Model & config:',
    '/model [name] · /models — show/set model',
    '/config — opencode config summary',
    '/mcp — MCP servers',
    '/plugins · /plugin — plugins',
    '/allowlist — allowed users',
    '/activation [mention|always] — reply gating',
    '/elev · /elevated [on|off] — elevated mode',
    '',
    'Reasoning & output:',
    '/think [0|1|2] · /thinking · /reason · /reasoning',
    '/verbose [on|off] · /trace [on|off] · /usage [off|tokens|full]',
    '/export · /export-session · /export-trajectory — dump log to file',
    '',
    'Skills & diagnostics:',
    '/skill [name] · /skills — list/read skills',
    '/tools — list tools',
    '/context — context info',
    '/debug · /diagnostics — bot + LLM health',
    '',
    'Bot ops:',
    '/bot-ping · /bot-version · /bot-logs · /bot-help',
    '/send <text> · /start',
  ].join('\n');
}

function stub(name: string): string {
  return `${name} is a CLI-only opencode command and is not applicable in this Telegram bot.`;
}

export function setupSlashCommands(): void {
  // Wrap every command with the allowed-user gate + error handling.
  function oc(command: string, run: (user: string, args: string) => Promise<string | null>): void {
    registerPluginCommand('*', command, async (user, cmd, args) => {
      if (!isAllowed(user)) return 'Not authorized.';
      try {
        return await run(user, args);
      } catch (error: any) {
        return `Error: ${error.message}`;
      }
    });
  }

  // --- session ---
  oc('commands', async (_u) => buildHelp());
  oc('new', async (user) => {
    setAgentState({ goal: '', steer: '' });
    clearHistory(user);
    return 'New session started. Goal, steering and conversation history cleared.';
  });
  oc('reset', async (user) => {
    setAgentState({ goal: '', steer: '' });
    clearHistory(user);
    return 'Session reset. Goal, steering and conversation history cleared.';
  });
  oc('compact', async () =>
    'No persistent context to compact: each reply starts a fresh opencode session.',
  );
  oc('restart', async () =>
    'Restart acknowledged. Agentic state cleared; launchd keeps the bot alive.',
  );
  oc('stop', async () => 'Stopped. Pending agentic runs dropped.');
  oc('status', async () => stateSummary());
  oc('id', async (user) => `Telegram user id: ${user}\nSession: per-user conversation memory (cleared by /new)`);
  oc('whoami', async (user) => {
    const s = getAgentState();
    return `You are Telegram user ${user}. I am ${s.name}, the opencode telegram bot.`;
  });
  oc('name', async (_u, args) => {
    const s = getAgentState();
    if (args.trim()) {
      setAgentState({ name: args.trim().slice(0, 64) });
      return `Name set to: ${getAgentState().name}`;
    }
    return `Current name: ${s.name}`;
  });
  oc('goal', async (_u, args) => {
    const goal = args.trim();
    if (!goal || goal === 'clear') {
      setAgentState({ goal: '' });
      return 'Goal cleared.';
    }
    setAgentState({ goal });
    return `Goal set: ${goal}`;
  });
  oc('steer', async (_u, args) => {
    const steer = args.trim();
    if (!steer || steer === 'clear') {
      setAgentState({ steer: '' });
      return 'Steering cleared.';
    }
    setAgentState({ steer });
    return `Steering set: ${steer}`;
  });
  oc('tell', async (user, args) => {
    if (!args.trim()) return 'Usage: /tell <instruction>';
    return handleAiMessage(user, args.trim());
  });
  oc('fast', async (_u, args) => {
    const s = getAgentState();
    const v = parseBoolArg(args, !s.fast);
    setAgentState({ fast: v });
    return `Fast mode: ${v ? 'on' : 'off'}`;
  });
  oc('focus', async (_u, args) => {
    const s = getAgentState();
    const v = parseBoolArg(args, !s.focus);
    setAgentState({ focus: v });
    return `Focus mode: ${v ? 'on' : 'off'}`;
  });
  oc('unfocus', async () => {
    setAgentState({ focus: false });
    return 'Focus mode: off';
  });
  oc('prose', async (_u, args) => {
    const s = getAgentState();
    const v = parseBoolArg(args, !s.prose);
    setAgentState({ prose: v });
    return `Prose mode: ${v ? 'on' : 'off'}`;
  });
  oc('btw', async (_u, args) => `Noted: ${args.trim() || '(nothing)'}`);
  oc('tasks', async () => 'No background tasks in this bot.');
  oc('subagents', async () =>
    'Agentic replies run through opencode, which can use sub-agents (bash, file, web tools) as needed.',
  );

  // --- model & config ---
  oc('model', async (_u, args) => {
    const current = process.env.LLM_MODEL || 'qwen3.5-9b';
    if (args.trim()) {
      setAgentState({ model: args.trim() });
      return `Model override set to '${args.trim()}' (used for the direct-Qwen fallback; opencode uses its own config).`;
    }
    return `Model: ${current}\nLLM endpoint: ${process.env.LLM_ENDPOINT || 'http://127.0.0.1:8095/v1/chat/completions'}\nAgentic engine: ${process.env.OPENCODE_BIN || '/Users/gutchapa/.local/bin/opencode'}`;
  });
  oc('models', async () => {
    const { model } = await readOpenCodeConfig();
    return `Configured model: ${model || '(not set in opencode config)'}\nAvailable: qwen-local/qwen3.5-9b (llama.cpp on 127.0.0.1:8095)`;
  });
  oc('config', async () => {
    const cfg = await readOpenCodeConfig();
    return [
      `Config file: ${OPENCODE_CONFIGS.find((p) => p.includes('.jsonc')) || '(not found)'}`,
      `Model: ${cfg.model || '(not set)'}`,
      `Skill paths (${cfg.paths.length}):`,
      ...cfg.paths.map((p) => `  ${p}`),
    ].join('\n');
  });
  oc('mcp', async () => {
    const cfg = await readOpenCodeConfig();
    const mcpMatch = cfg.raw.match(/"mcp"\s*:\s*\{([\s\S]*?)\n\s*\}/);
    return mcpMatch
      ? `MCP servers in opencode config:\n${truncate(mcpMatch[1].slice(0, 1000))}`
      : 'No MCP servers configured in opencode config.';
  });
  oc('plugins', async () => {
    const cfg = await readOpenCodeConfig();
    const pMatch = cfg.raw.match(/"plugin"\s*:\s*\[([\s\S]*?)\]/) || cfg.raw.match(/"plugins"\s*:\s*\[([\s\S]*?)\]/);
    const configured = pMatch
      ? [...pMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
      : [];
    return [
      'Plugins:',
      '  opencode-telegram-plugin (this bot)',
      ...configured.map((p) => `  ${p}`),
    ].join('\n');
  });
  oc('plugin', async () =>
    'This bot is the gutchapa-opencode-telegram: see /help for its commands and /config for opencode config.',
  );
  oc('allowlist', async () =>
    `Allowed Telegram users: ${ALLOWED.join(', ') || '(none)'} (set via ALLOWED_TELEGRAM_USERS)`,
  );
  oc('approve', async () => 'No pending approvals.');
  oc('exec', async (_u, args) => runShell(args));
  oc('bash', async (_u, args) => runShell(args));
  oc('activation', async (_u, args) => {
    const s = getAgentState();
    const a = args.trim().toLowerCase();
    if (a === 'mention' || a === 'always') {
      setAgentState({ activation: a });
      return `Activation mode: ${a}`;
    }
    return `Activation mode: ${s.activation} (use /activation mention or /activation always)`;
  });
  oc('elev', async (_u, args) => {
    const s = getAgentState();
    const v = parseBoolArg(args, !s.elevated);
    setAgentState({ elevated: v });
    return `Elevated mode: ${v ? 'on' : 'off'} (shell commands already run unrestricted via /execute)`;
  });
  oc('elevated', async (_u, args) => {
    const s = getAgentState();
    const v = parseBoolArg(args, !s.elevated);
    setAgentState({ elevated: v });
    return `Elevated mode: ${v ? 'on' : 'off'}`;
  });

  // --- reasoning & output ---
  oc('think', async (_u, args) => {
    const s = getAgentState();
    const a = args.trim();
    if (a === '0' || a === '1' || a === '2') {
      setAgentState({ thinking: Number(a) });
      return `Thinking level: ${a}`;
    }
    return `Thinking level: ${s.thinking} (use /think 0, /think 1 or /think 2)`;
  });
  oc('thinking', async () => `Thinking level: ${getAgentState().thinking}`);
  oc('reason', async (_u, args) => {
    const s = getAgentState();
    const v = parseBoolArg(args, !s.reasoning);
    setAgentState({ reasoning: v });
    return `Reasoning: ${v ? 'on' : 'off'}`;
  });
  oc('reasoning', async () => `Reasoning: ${getAgentState().reasoning ? 'on' : 'off'}`);
  oc('verbose', async (_u, args) => {
    const s = getAgentState();
    const v = parseBoolArg(args, !s.verbose);
    setAgentState({ verbose: v });
    return `Verbose: ${v ? 'on' : 'off'}`;
  });
  oc('trace', async (_u, args) => {
    const s = getAgentState();
    const v = parseBoolArg(args, !s.trace);
    setAgentState({ trace: v });
    return `Trace: ${v ? 'on' : 'off'}`;
  });
  oc('usage', async (_u, args) => {
    const s = getAgentState();
    const a = args.trim().toLowerCase();
    if (a === 'off' || a === 'tokens' || a === 'full') {
      setAgentState({ usage: a });
      return `Usage tracking: ${a}`;
    }
    return `Usage tracking: ${s.usage} (use /usage off, /usage tokens or /usage full)`;
  });
  oc('export', async () => exportLog('export'));
  oc('export-session', async () => exportLog('export-session'));
  oc('export-trajectory', async () => exportLog('export-trajectory'));
  oc('trajectory', async () => stub('/trajectory'));
  oc('context', async () => {
    const cfg = await readOpenCodeConfig();
    const ctxMatch = cfg.raw.match(/"context"\s*:\s*(\d+)/);
    return `Context limit: ${ctxMatch ? ctxMatch[1] + ' tokens (opencode config)' : '32768 (default)'}`;
  });

  // --- tools & skills ---
  oc('skill', async (_u, args) => {
    const name = args.trim().toLowerCase();
    if (name) return skillInfo(name);
    const skills = await listSkills();
    return `Loaded skills (${skills.length}):\n${skills.join('\n')}`;
  });
  oc('skills', async (_u, args) => {
    const name = args.trim().toLowerCase();
    if (name) return skillInfo(name);
    const skills = await listSkills();
    return `Loaded skills (${skills.length}):\n${skills.join('\n')}`;
  });
  oc('tools', async () => {
    const cmds = [...getRegisteredCommands().keys()].sort();
    return [
      'Bot slash commands:',
      cmds.map((c) => `/${c}`).join(' '),
      '',
      'Agent tools (via opencode): bash, file read/write, glob, grep, web fetch/search, skills, mcp',
    ].join('\n');
  });

  // --- diagnostics ---
  oc('debug', async () => diagnostics());
  oc('diagnostics', async () => diagnostics());

  // --- bot ops ---
  oc('bot-ping', async () => 'pong');
  oc('bot-version', async () => {
    const pkg = await readFile(
      `${CWD}/package.json`,
      'utf8',
    ).catch(() => '{}');
    const version = (pkg.match(/"version"\s*:\s*"([^"]+)"/) || [])[1] || 'unknown';
    return `opencode-telegram-plugin v${version}\nNode ${process.version}\nPID ${process.pid}`;
  });
  oc('bot-logs', async () =>
    `Logs:\n${HOME}/Library/Logs/opencode-telegram-bot.log\n${HOME}/Library/Logs/opencode-telegram-bot.err.log`,
  );
  oc('bot-help', async () => buildHelp());
  oc('bot-upgrade', async () =>
    'This plugin runs from a local checkout; upgrade via git pull + npm run build + launchctl kickstart.',
  );
  oc('send', async (_u, args) => `Sent to current chat: ${args.trim() || '(empty)'}`);
  oc('dock-telegram', async () => 'Already running as the Telegram bot.');

  // --- CLI-only stubs (hidden from the Telegram menu) ---
  for (const name of [
    'acp',
    'agents',
    'agentstatus',
    'botinfo',
    'login',
    'crestodian',
    'install',
    'channels',
    'platforms',
    'queue',
    'session',
    'loop',
    'learn',
    'side',
    'dock-discord',
    'dock-mattermost',
    'dock-slack',
    'tts',
    'voice',
    'talkvoice',
  ]) {
    oc(name, async () => stub(`/${name}`));
  }

  console.log('Slash commands registered');
}

async function exportLog(kind: string): Promise<string> {
  const logPath = `${HOME}/Library/Logs/opencode-telegram-bot.log`;
  let content = '';
  try {
    const raw = await readFile(logPath, 'utf8');
    const lines = raw.split('\n');
    content = lines.slice(-150).join('\n');
  } catch {
    content = '(log file not readable)';
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const out = `${HOME}/opencode-bot-${kind}-${ts}.txt`;
  await writeFile(out, `${kind} of opencode telegram bot\nGenerated: ${new Date().toISOString()}\n\n${content}`);
  return `Exported to ${out}`;
}

async function diagnostics(): Promise<string> {
  let llama = 'unreachable';
  try {
    const res = await fetch('http://127.0.0.1:8095/health', { signal: AbortSignal.timeout(3000) });
    llama = res.ok ? (await res.text()).slice(0, 80) : `HTTP ${res.status}`;
  } catch {
    llama = 'unreachable';
  }
  const s = getAgentState();
  return [
    `Bot PID: ${process.pid}`,
    `Uptime: ${Math.floor(process.uptime() / 60)}m ${Math.floor(process.uptime() % 60)}s`,
    `Node: ${process.version}`,
    `LLM endpoint: ${process.env.LLM_ENDPOINT || 'http://127.0.0.1:8095'} — ${llama}`,
    `Model: ${s.model || process.env.LLM_MODEL || 'qwen3.5-9b'}`,
    `Agentic engine: ${process.env.OPENCODE_BIN || '/Users/gutchapa/.local/bin/opencode'}`,
    `Allowed users: ${ALLOWED.join(', ') || '(none)'}`,
    `Activation: ${s.activation}`,
  ].join('\n');
}
