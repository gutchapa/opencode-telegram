import { initializeBotToken, resolveBotToken } from './sdk/provider-auth';
import { initialize } from './runtime';
import { setOpencodeClient } from './ai-handler';

// Minimal local types matching the opencode v1 plugin contract so this package
// doesn't require a hard dependency on @opencode-ai/plugin at build time.
type PluginOptions = Record<string, unknown>;
type PluginInput = {
  client?: unknown;
  directory?: string;
  project?: unknown;
  serverUrl?: URL;
};

// Signatures of the OpenCode-internal crash seen in issue #1. It originates in
// opencode's provider catalog code, not in this plugin.
const PROVIDER_CRASH_RE = /n\.provider|Provider\.list|ProviderHttpApi|defaultModelIDs/;

function logPluginStartupError(error: any): void {
  const message = error?.message || String(error);
  const stack = String(error?.stack || '');
  const text = `${message}\n${stack}`;

  if (PROVIDER_CRASH_RE.test(text)) {
    console.error(
      'gutchapa-opencode-telegram: startup was shielded from an OpenCode-internal provider crash.\n' +
        '  This is an OpenCode bug, not this plugin. A "provider" entry in your opencode.json is ' +
        'resolving to an empty or null model list, so OpenCode crashed while listing providers.\n' +
        '  Fix: edit opencode.json and remove or correct the offending provider/model entry, then ' +
        'restart opencode. The Telegram bot is disabled this session but OpenCode keeps running.\n' +
        `  raw error: ${message}`,
    );
    return;
  }

  console.error(
    'gutchapa-opencode-telegram: failed to start without crashing. The Telegram bot is disabled ' +
      'this session but OpenCode continues to run.\n' +
      '  Check your opencode.json provider/model entries, then restart opencode.\n' +
      `  Check your TELEGRAM_BOT_TOKEN / plugin "botToken" option if the bot did not start.\n` +
      `  raw error: ${message}`,
  );
}

async function server(input: PluginInput, options?: PluginOptions) {
  try {
    const enabled =
      options?.enabled === true ||
      options?.enabled === 'true' ||
      process.env.TELEGRAM_PLUGIN_ENABLED === '1' ||
      process.env.TELEGRAM_PLUGIN_ENABLED === 'true';

    // Wire the OpenCode client so the AI handler can talk to it later. Kept
    // inside the guard so a future change here can never abort server startup.
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

    await initialize();
    return {};
  } catch (error: any) {
    logPluginStartupError(error);
    return {};
  }
}

export default {
  id: 'gutchapa-opencode-telegram',
  server,
};
