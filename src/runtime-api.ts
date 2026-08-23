import { registerPluginCommand, handleCommand as sdkHandleCommand } from './sdk/plugin-runtime';

export async function setupRuntimeApi(): Promise<void> {
  // Runtime API setup
  registerPluginCommand('*', 'help', async (user, cmd, args) => {
    console.log('Showing help');
    return 'Available commands:\n/execute <cmd> - run a shell command\n/read <path> - read a file\n/search <pattern> [path] - grep for a pattern\n/list [path] - list a directory\n/getstatus - bot status\n/accounts - show model & provider info\n/allow-from - show allowed users\n/help - this help\n/commands - full command list (incl. /reset /restart /compact /model /tools /skill /goal /steer /tell ...)\n/start - welcome\n\nAgentic replies use opencode with the full skill library (autoresearch, to-issues, triage, grill-me, caveman, zoom-out, firehose-api, ego-browser, memory-*, driving-assistant, fli, etc.).';
  });

  registerPluginCommand('*', 'start', async (user, cmd, args) => {
    console.log('Starting bot');
    return 'Bot started successfully!';
  });
}

export async function handleCommand(user: string, username: string, command: string): Promise<string | null> {
  return sdkHandleCommand(user, username, command);
}
