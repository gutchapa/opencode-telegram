import { getBotToken } from './sdk/provider-auth';
import { getRegisteredCommands } from './sdk/plugin-runtime';
import https from 'https';

// Short descriptions shown in the Telegram command menu (typing "/").
// Keyed by registered command name. Commands without an entry are skipped.
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  acp: 'ACP protocol (gateway-only)',
  activation: 'Reply gating: mention or always',
  agents: 'Agent sessions (gateway-only)',
  agentstatus: 'Agent status (gateway-only)',
  allowfrom: 'Allow a user to use the bot',
  allowlist: 'List allowed users',
  approve: 'Approve a pending agent action',
  bash: 'Run a shell command',
  blockfrom: 'Block a user from the bot',
  'bot-help': 'Bot help and command list',
  'bot-logs': 'Show recent bot logs',
  'bot-ping': 'Ping the bot',
  'bot-upgrade': 'Upgrade the bot (gateway-only)',
  'bot-version': 'Show bot version',
  btw: 'Random aside from the bot',
  channels: 'Channel/platform list (gateway-only)',
  commands: 'List all slash commands',
  compact: 'Context compaction note',
  config: 'Show opencode config',
  context: 'Show context info',
  crestodian: 'Crestodian (gateway-only)',
  debug: 'Bot + LLM health check',
  diagnostics: 'Bot diagnostics',
  'dock-discord': 'Connect Discord (gateway-only)',
  'dock-mattermost': 'Connect Mattermost (gateway-only)',
  'dock-slack': 'Connect Slack (gateway-only)',
  'dock-telegram': 'Connect Telegram (gateway-only)',
  elev: 'Elevated mode on',
  elevated: 'Elevated mode toggle',
  exec: 'Run a shell command',
  execute: 'Run a shell command',
  export: 'Export conversation log',
  'export-session': 'Export session log',
  'export-trajectory': 'Export trajectory log',
  fast: 'Fast mode toggle',
  focus: 'Focus mode toggle',
  gateway: 'Gateway (gateway-only)',
  getbalance: 'Show API balance',
  getchannel: 'Show current channel',
  getinfo: 'Show provider info',
  getstatus: 'Show bot status',
  goal: 'Set an ongoing goal for the agent',
  help: 'Show help',
  id: 'Show your user id',
  install: 'Install plugin (gateway-only)',
  learn: 'Learn command (gateway-only)',
  list: 'List a directory',
  listaccounts: 'List configured accounts',
  listallow: 'List allowed users',
  login: 'Login (gateway-only)',
  loop: 'Loop mode (gateway-only)',
  mcp: 'MCP server info',
  model: 'Show or set the model',
  models: 'List available models',
  name: 'Show or set bot name',
  new: 'Start a fresh session',
  botinfo: 'Bot info (gateway-only)',
  platforms: 'Platform list (gateway-only)',
  plugin: 'Plugin info',
  plugins: 'List plugins',
  prose: 'Prose mode toggle',
  queue: 'Task queue (gateway-only)',
  read: 'Read a file',
  reason: 'Reasoning output toggle',
  reasoning: 'Reasoning output toggle',
  reset: 'Reset session, goal and steering',
  resetaccount: 'Reset an account',
  restart: 'Restart bot / clear agent state',
  search: 'Search files with grep',
  send: 'Send a message to the chat',
  session: 'Session info (gateway-only)',
  setaccount: 'Set active account',
  setchannel: 'Set active channel',
  side: 'Side-by-side output toggle',
  skill: 'Read a skill description',
  skills: 'List loaded skills',
  start: 'Welcome message',
  status: 'Show bot status',
  steer: 'Set a steering note for the agent',
  stop: 'Stop pending agentic runs',
  subagents: 'Subagent info',
  talkvoice: 'Voice chat (gateway-only)',
  tasks: 'Task management',
  tell: 'Send a direct instruction to the agent',
  think: 'Set thinking level (0-2)',
  thinking: 'Thinking display toggle',
  tools: 'List available tools',
  trace: 'Trace mode toggle',
  trajectory: 'Export trajectory',
  tts: 'Text-to-speech (gateway-only)',
  unfocus: 'Unfocus mode toggle',
  usage: 'Usage tracking (off/tokens/full)',
  verbose: 'Verbose mode toggle',
  voice: 'Voice mode (gateway-only)',
  whoami: 'Show who you are',
};

const TELEGRAM_MAX_COMMANDS = 100;
const TELEGRAM_MAX_COMMAND_LENGTH = 32;

function normalizeCommandName(name: string): string {
  return name.trim().toLowerCase().replace(/^\//, '').replace(/-/g, '_');
}

function telegramApiCall(token: string, method: string, body: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.ok) {
            resolve();
          } else {
            reject(new Error(response.description || `${method} failed`));
          }
        } catch (error: any) {
          reject(error);
        }
      });
    });
    req.on('error', (error: any) => {
      reject(error);
    });
    req.write(postData);
    req.end();
  });
}

// Registers the bot's slash commands with Telegram so typing "/" in a chat
// shows the command menu.
export async function syncTelegramMenuCommands(): Promise<void> {
  const token = getBotToken();
  if (!token) {
    console.error('No bot token found; skipping command menu sync');
    return;
  }

  const registered = getRegisteredCommands();
  const commands: { command: string; description: string }[] = [];

  for (const [, entry] of registered) {
    const normalized = normalizeCommandName(entry.command);
    if (!/^[a-z0-9_]{1,32}$/.test(normalized)) continue;
    if (normalized.length > TELEGRAM_MAX_COMMAND_LENGTH) continue;
    const description = (COMMAND_DESCRIPTIONS[entry.command] || '').trim();
    if (!description) continue;
    commands.push({ command: normalized, description: description.slice(0, 256) });
    if (commands.length >= TELEGRAM_MAX_COMMANDS) break;
  }

  if (commands.length === 0) {
    console.error('No describable commands to register in the menu');
    return;
  }

  const scopes = [
    { label: 'default', options: {} },
    { label: 'all_group_chats', options: { scope: { type: 'all_group_chats' } } },
  ];

  for (const s of scopes) {
    try {
      await telegramApiCall(token, 'setMyCommands', {
        commands,
        ...s.options,
      });
      console.log(`Telegram command menu synced (${commands.length} commands, scope=${s.label})`);
    } catch (error: any) {
      console.error(`setMyCommands failed (scope=${s.label}):`, error.message);
    }
  }
}
