import { registerPluginCommand, handleCommand } from './sdk/plugin-runtime';
import { getBotToken } from './sdk/provider-auth';

function isAllowed(user: string): boolean {
  const allowed = (process.env.ALLOWED_TELEGRAM_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return allowed.includes(user);
}

export function setupAccounts(): void {
  registerPluginCommand('*', 'setaccount', async (user, cmd, args) => {
    if (!isAllowed(user)) return 'Not authorized.';
    return 'Account management is not implemented in this bot.';
  });

  registerPluginCommand('*', 'resetaccount', async (user, cmd, args) => {
    if (!isAllowed(user)) return 'Not authorized.';
    return 'Account management is not implemented in this bot.';
  });

  registerPluginCommand('*', 'listaccounts', async (user, cmd, args) => {
    if (!isAllowed(user)) return 'Not authorized.';
    console.log('Listing accounts');
    const model = process.env.OPENCODE_MODEL || 'opencode default';
    const opencodeBin = process.env.OPENCODE_BIN || '/Users/gutchapa/.local/bin/opencode';
    return `Model: ${model}\nAgentic engine: ${opencodeBin}`;
  });
}
