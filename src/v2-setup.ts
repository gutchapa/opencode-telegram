// OpenCode V2 plugin setup.
//
// V2 loads plugins through `plugins` in opencode.json(c) and calls `setup(ctx)`,
// where `ctx` is a server client plus plugin-only helpers. This module keeps the
// wiring in the CJS build and is re-exported by dist/v2.mjs, because
// @opencode/plugin is ESM-only and cannot be required from CommonJS.
import { resolveBotToken, initializeBotToken } from './sdk/provider-auth';
import { initialize } from './runtime';
import { setV2Context } from './ai-handler';
import { configureEventNotify, handleOpencodeEvent } from './event-notify';

type V2Context = any;

function isEnabled(options: Record<string, unknown>): boolean {
  return (
    options.enabled === true ||
    options.enabled === 'true' ||
    process.env.TELEGRAM_PLUGIN_ENABLED === '1' ||
    process.env.TELEGRAM_PLUGIN_ENABLED === 'true'
  );
}

export async function setupV2(ctx: V2Context): Promise<() => void> {
  const options = ((ctx && ctx.options) || {}) as Record<string, unknown>;

  // Give the agentic handler a live V2 context so replies go through
  // ctx.session instead of spawning `opencode run`.
  setV2Context(ctx);

  const notifyChatId =
    (options.chatId as string | undefined) ??
    (options.notifyChatId as string | undefined) ??
    process.env.TELEGRAM_CHAT_ID ??
    process.env.TELEGRAM_NOTIFY_CHAT_ID ??
    null;

  configureEventNotify({
    directory: ctx && ctx.location ? ctx.location.directory : undefined,
    chatId: notifyChatId,
  });

  const earlyToken = resolveBotToken(options);
  if (earlyToken) initializeBotToken(earlyToken);

  // Push notifications use the public event stream, which exists whether or not
  // Telegram polling is enabled.
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        await handleOpencodeEvent(event);
      }
    } catch (error: any) {
      if (!controller.signal.aborted) {
        console.error('[gutchapa-opencode-telegram] event stream ended:', error?.message || error);
      }
    }
  })();

  try {
    if (isEnabled(options)) {
      const token = resolveBotToken(options);
      if (token) {
        initializeBotToken(token);
      } else {
        console.error(
          'gutchapa-opencode-telegram: no bot token found. Set the "botToken" plugin ' +
            'option or the TELEGRAM_BOT_TOKEN environment variable.',
        );
      }
      await initialize();
    } else {
      console.log(
        'gutchapa-opencode-telegram: Telegram polling disabled (set { "enabled": true } or ' +
          'TELEGRAM_PLUGIN_ENABLED=1 to enable). Push notifications still active.',
      );
    }
  } catch (error: any) {
    // Never reject opencode startup because the bot failed to come up.
    console.error(
      'gutchapa-opencode-telegram: bot failed to start; opencode keeps running. ' +
        (error?.message || String(error)),
    );
  }

  return () => controller.abort();
}
