import { registerPluginCommand, handleCommand as sdkHandleCommand } from './sdk/plugin-runtime';
import { getAgentState } from './agent-state';
import { getBotInfo, getPluginVersion, formatUptime } from './bot-identity';

function isAllowed(user: string): boolean {
  const allowed = (process.env.ALLOWED_TELEGRAM_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return allowed.includes(user);
}

function localTime(): string {
  try {
    return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  } catch {
    return new Date().toISOString();
  }
}

export async function setupRuntimeApi(): Promise<void> {
  // Runtime API setup
  registerPluginCommand('*', 'help', async (user, cmd, args) => {
    console.log('Showing help');
    return 'Available commands:\n/execute <cmd> - run a shell command\n/read <path> - read a file\n/search <pattern> [path] - grep for a pattern\n/list [path] - list a directory\n/status - bot status\n/botinfo - this bot\'s Telegram identity\n/help - this help\n/commands - full command list (incl. /model, /diagnostics, /goal, /steer ...)\n/start - welcome\n\nPlain messages go straight to the model like openclaw; no command prefix needed.';
  });

  registerPluginCommand('*', 'start', async (user, cmd, args) => {
    console.log('Starting bot');
    if (!isAllowed(user)) {
      return (
        "Hi — this is a private OpenCode bot and you're not on its allowlist.\n" +
        'Try /help to see what works here.'
      );
    }
    const s = getAgentState();
    const model = (process.env.OPENCODE_MODEL || '').trim() || "opencode-config default";
    const info = await getBotInfo();
    const me = info ? `@${info.username}` : 'this chat';
    const lines = [
      "Hi — I'm your private OpenCode bot. Send anything, I'll run it through the agent. /help for commands.",
      '',
      `• Time: ${localTime()} IST`,
      `• Model: ${model}`,
      `• Plugin: gutchapa-opencode-telegram v${getPluginVersion()} · up ${formatUptime()}`,
      `• Me: ${me} · you: ${user}`,
    ];
    if (s.goal) lines.push(`• Goal: ${s.goal}`);
    return lines.join('\n');
  });
}

export async function handleCommand(user: string, username: string, command: string): Promise<string | null> {
  return sdkHandleCommand(user, username, command);
}
