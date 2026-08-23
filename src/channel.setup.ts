import { registerPluginCommand, handleCommand } from './sdk/plugin-runtime';

export function setupChannel(): void {
  registerPluginCommand('*', 'setchannel', async (user, cmd, args) => {
    return 'This bot uses direct Telegram messages; channel setup is not applicable.';
  });

  registerPluginCommand('*', 'getchannel', async (user, cmd, args) => {
    console.log('Getting channel');
    return 'This bot uses direct Telegram messages with allowed users.';
  });
}
