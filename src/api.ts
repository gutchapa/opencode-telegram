import { registerPluginCommand } from './sdk/plugin-runtime';
import { getPluginVersion, formatUptime } from './bot-identity';

export function setupApi(): void {
  registerPluginCommand('*', 'getbalance', async (user, cmd, args) => {
    console.log('Getting balance');
    return 'No balance API wired — this bot runs on OpenCode Zen free-tier models, so there is nothing to top up. See /status for the active model.';
  });

  registerPluginCommand('*', 'getstatus', async (user, cmd, args) => {
    console.log('Getting status');
    const model = (process.env.OPENCODE_MODEL || '').trim() || 'opencode-config default';
    return `opencode-bot up ${formatUptime()} · model ${model} · plugin v${getPluginVersion()} (full: /status)`;
  });

  registerPluginCommand('*', 'getinfo', async (user, cmd, args) => {
    console.log('Getting info');
    const model = (process.env.OPENCODE_MODEL || '').trim() || 'opencode-config default';
    return `gutchapa-opencode-telegram v${getPluginVersion()} · model ${model} · up ${formatUptime()} (identity: /botinfo)`;
  });
}
