// Smoke test: auth gates + no-echo fallback. No model calls, no network
// (stranger unknown-command path returns canned/Not authorized without LLM).
// Run: ALLOWED_TELEGRAM_USERS=REDACTED_TELEGRAM_ID node scripts/smoke-test.js
const assert = require('assert');

process.env.ALLOWED_TELEGRAM_USERS = process.env.ALLOWED_TELEGRAM_USERS || 'REDACTED_TELEGRAM_ID';

const { setupCommands } = require('../dist/commands.js');
const { setupAllowFrom } = require('../dist/allow-from.js');
const { setupAccounts } = require('../dist/accounts.js');
const { setupSlashCommands } = require('../dist/slash-commands.js');
const { handleCommand } = require('../dist/runtime/command-handler.js');
require('../dist/ai-handler.js'); // registers AI fallback handler

setupCommands();
setupAllowFrom();
setupAccounts();
setupSlashCommands();

(async () => {
  const t = async (name, actual, want) => {
    assert.strictEqual(actual, want, `${name}: got ${JSON.stringify(actual)}`);
    console.log(`ok - ${name}`);
  };
  await t('stranger execute refused', await handleCommand('999', 'x', '/execute whoami'), 'Not authorized.');
  await t('stranger listallow refused', await handleCommand('999', 'x', '/listallow'), 'Not authorized.');
  await t('stranger listaccounts refused', await handleCommand('999', 'x', '/listaccounts'), 'Not authorized.');
  await t('stranger setaccount refused', await handleCommand('999', 'x', '/setaccount a b'), 'Not authorized.');
  await t('stranger unknown refused', await handleCommand('999', 'x', 'answer me'), 'Not authorized.');
  await t('owner listallow works', await handleCommand('REDACTED_TELEGRAM_ID', 'x', '/listallow'), 'Allowed Telegram users: REDACTED_TELEGRAM_ID');
  await t('owner execute works', await handleCommand('REDACTED_TELEGRAM_ID', 'x', '/execute echo HI'), 'HI');
  const { parseTranscript } = require('../dist/voice.js');
  await t('transcript segments parsed',
    parseTranscript('[00:00:00.000 --> 00:00:02.000]  hello world\nwhisper_print_timings: total time = 1ms\n'),
    'hello world');
  await t('transcript empty on noise only', parseTranscript('ggml init\nwhisper_print_timings: x\n'), '');
  console.log('smoke: all passed');
})().catch((e) => {
  console.error('smoke FAILED:', e.message);
  process.exit(1);
});
