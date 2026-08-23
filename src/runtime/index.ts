import { getBotToken, initializeBotToken, resolveBotToken } from '../sdk/provider-auth';
import { startBot, stopBot, isBotStarted } from './telegram-bot';
import { setupAccounts } from '../accounts';
import { setupAllowFrom } from '../allow-from';
import { setupApi } from '../api';
import { setupChannel } from '../channel.setup';
import { setupRuntimeApi } from '../runtime-api';
import { setupCommands } from '../commands';
import { setupSlashCommands } from '../slash-commands';

// Side-effect import: registers the AI message handler with the plugin runtime.
// Must NOT be a named/namespace import (tsc elides unused imports, which would
// silently skip the setAiHandler() call at module load).
import '../ai-handler';

let botStarted = false;

export async function initialize(): Promise<void> {
  console.log('Initializing opencode...');

  if (!getBotToken()) {
    const token = resolveBotToken();
    if (token) {
      initializeBotToken(token);
      console.log('Bot token resolved from environment/config');
    }
  }

  setupAccounts();
  setupAllowFrom();
  setupApi();
  setupChannel();
  setupCommands();
  setupSlashCommands();
  await setupRuntimeApi();
  
  const token = getBotToken();
  if (!token) {
    console.error('No bot token found');
    return;
  }
  
  console.log('Setting up plugin commands...');
  
  startBot();
  
  console.log('opencode initialized');
}



export function start(): void {
  if (!botStarted) {
    initialize();
  } else {
    startBot();
  }
}

export function stop(): void {
  if (botStarted) {
    stopBot();
    botStarted = false;
  }
}
