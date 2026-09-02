import { registerPluginCommand, handleCommand } from './sdk/plugin-runtime';

export function setupAllowFrom(): void {
  registerPluginCommand('*', 'allowfrom', async (user, cmd, args) => {
    const allowed = (process.env.ALLOWED_TELEGRAM_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
    return `Allowed Telegram users are set via ALLOWED_TELEGRAM_USERS.\nCurrently allowed: ${allowed.join(', ') || '(none)'}`;
  });

  registerPluginCommand('*', 'blockfrom', async (user, cmd, args) => {
    return 'To restrict users, set ALLOWED_TELEGRAM_USERS in the launchd plist (ai.local.opencode-telegram-bot).';
  });

  registerPluginCommand('*', 'listallow', async (user, cmd, args) => {
    console.log('Listing allowed users');
    const allowed = (process.env.ALLOWED_TELEGRAM_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
    return `Allowed Telegram users: ${allowed.join(', ') || '(none)'}`;
  });
}
