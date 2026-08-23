import { registerPluginCommand, handleCommand } from './sdk/plugin-runtime';
import { getBotToken } from './sdk/provider-auth';

export function setupAccounts(): void {
  registerPluginCommand('*', 'setaccount', async (user, cmd, args) => {
    const [username, newUsername] = args.split(' ');
    if (!username || !newUsername) {
      return 'Usage: /setaccount <username> <new_username>';
    }
    console.log(`Setting account ${username} to ${newUsername}`);
    return `Account ${username} set to ${newUsername}`;
  });

  registerPluginCommand('*', 'resetaccount', async (user, cmd, args) => {
    const username = args.trim();
    if (!username) {
      return 'Usage: /resetaccount <username>';
    }
    console.log(`Resetting account ${username}`);
    return `Account ${username} reset`;
  });

  registerPluginCommand('*', 'listaccounts', async (user, cmd, args) => {
    console.log('Listing accounts');
    const model = process.env.LLM_MODEL || 'qwen3.5-9b';
    const endpoint = process.env.LLM_ENDPOINT || 'http://127.0.0.1:8095/v1/chat/completions';
    const opencodeBin = process.env.OPENCODE_BIN || '/Users/gutchapa/.local/bin/opencode';
    return `Model: ${model}\nLLM endpoint: ${endpoint}\nAgentic engine: ${opencodeBin}`;
  });
}
