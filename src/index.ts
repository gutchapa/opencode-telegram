#!/usr/bin/env node
import { initialize } from './runtime';
import { initializeBotToken, resolveBotToken } from './sdk/provider-auth';

const botToken = resolveBotToken();
if (!botToken) {
  console.error(
    'TELEGRAM_BOT_TOKEN is not set. Provide it via the environment variable, ' +
      'a config.json "botToken" field, or a .env file.',
  );
  process.exit(1);
}
initializeBotToken(botToken);
initialize().catch(console.error);
