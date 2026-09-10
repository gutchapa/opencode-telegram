import { registerPluginCommand, handleCommand as sdkHandleCommand } from './sdk/plugin-runtime';

export async function setupRuntimeApi(): Promise<void> {
  // Runtime API setup
  registerPluginCommand('*', 'help', async (user, cmd, args) => {
    console.log('Showing help');
    return 'Available commands:\n/execute <cmd> - run a shell command\n/read <path> - read a file\n/search <pattern> [path] - grep for a pattern\n/list [path] - list a directory\n/getstatus - bot status\n/help - this help\n/commands - full command list (incl. /model, /diagnostics, /goal, /steer ...)\n/start - welcome\n\nPlain messages go straight to the model like openclaw; no command prefix needed.';
  });

  registerPluginCommand('*', 'start', async (user, cmd, args) => {
    console.log('Starting bot');
    return 'Bot started successfully!';
  });
}

export async function handleCommand(user: string, username: string, command: string): Promise<string | null> {
  return sdkHandleCommand(user, username, command);
}
