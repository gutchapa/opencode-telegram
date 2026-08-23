import { registerPluginCommand, handleCommand } from './sdk/plugin-runtime';

export function setupApi(): void {
  registerPluginCommand('*', 'getbalance', async (user, cmd, args) => {
    console.log('Getting balance');
    return 'Balance retrieved';
  });

  registerPluginCommand('*', 'getstatus', async (user, cmd, args) => {
    console.log('Getting status');
    return 'Status retrieved';
  });

  registerPluginCommand('*', 'getinfo', async (user, cmd, args) => {
    console.log('Getting info');
    return 'Info retrieved';
  });
}
