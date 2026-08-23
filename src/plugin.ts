import { initializeBotToken, resolveBotToken } from './sdk/provider-auth';
import { initialize } from './runtime';
import { setOpencodeClient } from './ai-handler';

// Minimal local types matching the opencode v1 plugin contract so this package
// compiles without a hard dependency on @opencode-ai/plugin.
type PluginOptions = Record<string, unknown>;
type PluginInput = {
  client?: unknown;
  directory?: string;
  project?: unknown;
  serverUrl?: URL;
};

async function server(input: PluginInput, options?: PluginOptions) {
  // Telegram polling is opt-in so installing the plugin never silently starts a
  // second poller (e.g. alongside the standalone launchd bot, which would cause
  // getUpdates conflicts). Enable with { "enabled": true } in the plugin config
  // or TELEGRAM_PLUGIN_ENABLED=1.
  const enabled =
    options?.enabled === true ||
    options?.enabled === 'true' ||
    process.env.TELEGRAM_PLUGIN_ENABLED === '1' ||
    process.env.TELEGRAM_PLUGIN_ENABLED === 'true';

  // Prefer the hosting opencode server for agentic replies instead of spawning
  // a nested `opencode run` process.
  setOpencodeClient(input?.client, input?.directory);

  if (!enabled) {
    console.log(
      'gutchapa-opencode-telegram: Telegram polling disabled (set { "enabled": true } or TELEGRAM_PLUGIN_ENABLED=1 to enable).',
    );
    return {};
  }

  const token = resolveBotToken(options);
  if (token) {
    initializeBotToken(token);
  } else {
    console.error(
      'gutchapa-opencode-telegram: no bot token found. Set it via plugin options ' +
        '({ "botToken": "..." }) or the TELEGRAM_BOT_TOKEN environment variable.',
    );
  }

  try {
    await initialize();
  } catch (error: any) {
    console.error('opencode-telegram-plugin failed to initialize:', error?.message || error);
  }
  return {};
}

export default {
  id: 'gutchapa-opencode-telegram',
  server,
};
