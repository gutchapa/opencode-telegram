// Push notifications for OpenCode events, mirroring what opencode-telegram
// offers: session idle/task-complete, permission requests with inline
// Allow/Always/Reject buttons, todos-complete, subtask-started, errors.
// Zero extra dependencies — uses node:https directly.
import https from 'https';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getBotToken } from './sdk/provider-auth';

type OpencodeClient = any;

let opencodeClient: OpencodeClient = null;
let opencodeDirectory: string | undefined;
let explicitChatId: string | null = null;

const sessionTitles = new Map<string, string>();
const sessionStatus = new Map<string, { status: string; lastSeenAt: number }>();

// callback_data shortening: monotonic counter -> (sessionID, permissionID)
let nextCallbackKey = 1;
const pendingPermissions = new Map<number, { sessionID: string; permissionID: string }>();

const SESSION_MAX_IDLE_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - SESSION_MAX_IDLE_MS;
  for (const [id, s] of sessionStatus) {
    if (s.lastSeenAt < cutoff) {
      sessionStatus.delete(id);
      sessionTitles.delete(id);
    }
  }
}, 10 * 60 * 1000).unref?.();

export function configureEventNotify(opts: {
  client?: unknown;
  directory?: string;
  chatId?: string | number | null;
}): void {
  if (opts.client) opencodeClient = opts.client;
  if (opts.directory) opencodeDirectory = opts.directory;
  if (opts.chatId != null && String(opts.chatId).trim()) {
    explicitChatId = String(opts.chatId).trim();
  }
}

function resolveNotifyChatId(): string | null {
  if (explicitChatId) return explicitChatId;
  const env =
    process.env.TELEGRAM_CHAT_ID ||
    process.env.TELEGRAM_NOTIFY_CHAT_ID ||
    process.env.DIGEST_CHAT_ID ||
    '';
  if (env.trim()) return env.trim();
  // Fall back to the last active chat persisted by the telegram poller so
  // notifications work without any extra env once the user has messaged.
  try {
    const f = join(process.env.HOME || '/tmp', '.opencode-telegram-state', 'active-chat-id');
    if (existsSync(f)) {
      const n = readFileSync(f, 'utf-8').trim();
      if (n && Number(n) > 0) return n;
    }
  } catch { /* no fallback */ }
  return null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function apiCall(method: string, payload: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const token = getBotToken();
    if (!token) {
      reject(new Error('no bot token'));
      return;
    }
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/${method}`,
        method: 'POST',
        family: 4,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok) resolve(parsed.result);
            else reject(new Error(`Telegram API: ${parsed.description || 'unknown'}`));
          } catch {
            reject(new Error(`Invalid JSON: ${data.slice(0, 100)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timeout ${method}`));
    });
    req.write(body);
    req.end();
  });
}

export async function sendNotify(
  text: string,
  inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
): Promise<void> {
  const chatId = resolveNotifyChatId();
  if (!chatId) return; // no target yet — silently skip like opencode-telegram does without env
  try {
    await apiCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
    });
  } catch (e: any) {
    console.error('[telegram-notify] send failed:', e.message);
  }
}

async function sendSessionIdle(title: string, sessionID: string): Promise<void> {
  if (process.env.TELEGRAM_NOTIFY_SESSION === '0') return;
  await sendNotify(
    [`<b>✅ Task Complete</b>`, ``, `<b>Session:</b> ${escapeHtml(title || sessionID)}`].join('\n'),
  );
}

async function sendPermissionRequest(
  sessionID: string,
  permissionID: string,
  title: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (process.env.TELEGRAM_NOTIFY_PERMISSION === '0') return;
  const lines = [`<b>🔔 Permission Request</b>`, ``, `<b>Action:</b> ${escapeHtml(title || 'permission')}`];
  if (metadata?.['command']) lines.push(`<b>Command:</b> <code>${escapeHtml(String(metadata['command']))}</code>`);
  if (metadata?.['path']) lines.push(`<b>Path:</b> <code>${escapeHtml(String(metadata['path']))}</code>`);
  const key = nextCallbackKey++;
  pendingPermissions.set(key, { sessionID, permissionID });
  const keyboard = [
    [
      { text: '✅ Allow', callback_data: `p:${key}:once` },
      { text: '✅ Always', callback_data: `p:${key}:always` },
      { text: '❌ Reject', callback_data: `p:${key}:reject` },
    ],
  ];
  await sendNotify(lines.join('\n'), keyboard);
}

async function sendTodosComplete(todos: Array<{ content: string; status: string }>): Promise<void> {
  if (process.env.TELEGRAM_NOTIFY_TODO === '0') return;
  const lines = [`<b>📋 All Tasks Complete</b>`, ``];
  for (const t of todos.slice(0, 10)) lines.push(`  ✅ ${escapeHtml(t.content)}`);
  if (todos.length > 10) lines.push(`  ... and ${todos.length - 10} more`);
  await sendNotify(lines.join('\n'));
}

async function sendSubtaskStarted(description: string, agent: string, prompt?: string): Promise<void> {
  if (process.env.TELEGRAM_NOTIFY_SUBTASK === '0') return;
  const lines = [
    `<b>🔀 Subtask Started</b>`,
    ``,
    `<b>Agent:</b> ${escapeHtml(agent || '?')}`,
    `<b>Description:</b> ${escapeHtml(description || '')}`,
  ];
  if (prompt) {
    const t = prompt.length > 200 ? prompt.slice(0, 200) + '...' : prompt;
    lines.push(`<b>Prompt:</b> ${escapeHtml(t)}`);
  }
  await sendNotify(lines.join('\n'));
}

async function sendError(message: string, sessionID?: string): Promise<void> {
  if (process.env.TELEGRAM_NOTIFY_ERROR === '0') return;
  const lines = [`<b>❌ Error</b>`, ``];
  if (sessionID) lines.push(`<b>Session:</b> ${escapeHtml(sessionID)}`);
  lines.push(escapeHtml(message));
  await sendNotify(lines.join('\n'));
}

// Called from the telegram poll loop for inline-button presses.
// answerFn/editFn are injected so this module stays transport-agnostic.
export async function handlePermissionCallback(
  data: string,
  answer: (text: string) => Promise<void>,
  editOriginal: (suffixLabel: string) => Promise<void>,
): Promise<boolean> {
  const parts = data.split(':');
  if (parts[0] !== 'p' || parts.length < 3) return false;
  const key = parseInt(parts[1], 10);
  const response = parts[2];
  if (response !== 'once' && response !== 'reject' && response !== 'always') {
    await answer('Invalid response').catch(() => {});
    return true;
  }
  const pending = pendingPermissions.get(key);
  if (!pending) {
    await answer('Permission request expired').catch(() => {});
    return true;
  }
  if (!opencodeClient?.session?.permission?.reply && !opencodeClient?.postSessionIdPermissionsPermissionId) {
    await answer('No opencode client (standalone mode)').catch(() => {});
    return true;
  }
  try {
    // Newer SDK shape first, legacy path-method fallback second.
    if (opencodeClient.session?.permission?.reply) {
      await opencodeClient.session.permission.reply({
        path: { id: pending.sessionID, permissionID: pending.permissionID },
        body: { response },
        query: opencodeDirectory ? { directory: opencodeDirectory } : undefined,
      });
    } else {
      await opencodeClient.postSessionIdPermissionsPermissionId({
        path: { id: pending.sessionID, permissionID: pending.permissionID },
        query: { directory: opencodeDirectory },
        body: { response },
      });
    }
    pendingPermissions.delete(key);
    const label = response === 'once' ? '✅ Allowed' : response === 'always' ? '✅ Always Allow' : '❌ Rejected';
    await answer(label).catch(() => {});
    await editOriginal(`→ ${label}`).catch(() => {});
  } catch (e: any) {
    await answer(`Error: ${(e.message || 'unknown').slice(0, 180)}`).catch(() => {});
  }
  return true;
}

// Main entry: called from plugin server()'s returned event() hook.
export async function handleOpencodeEvent(event: any): Promise<void> {
  try {
    switch (event?.type) {
      case 'session.status': {
        const { sessionID, status } = event.properties ?? {};
        if (!sessionID) break;
        const prev = sessionStatus.get(sessionID);
        sessionStatus.set(sessionID, {
          status: status?.type ?? prev?.status ?? 'unknown',
          lastSeenAt: Date.now(),
        });
        break;
      }
      case 'session.idle': {
        const { sessionID } = event.properties ?? {};
        if (!sessionID) break;
        const st = sessionStatus.get(sessionID);
        if (st && st.status !== 'idle') break; // only notify real idle transitions
        await sendSessionIdle(sessionTitles.get(sessionID) || sessionID, sessionID);
        break;
      }
      case 'permission.updated': {
        const p = event.properties ?? {};
        if (!p.id || !p.sessionID) break;
        await sendPermissionRequest(p.sessionID, p.id, p.title ?? 'permission', p.metadata ?? {});
        break;
      }
      case 'todo.updated': {
        const { todos } = event.properties ?? {};
        if (!Array.isArray(todos) || todos.length === 0) break;
        if (todos.every((t: any) => t.status === 'completed' || t.status === 'cancelled')) {
          await sendTodosComplete(todos);
        }
        break;
      }
      case 'message.part.updated': {
        const { part } = event.properties ?? {};
        if (part?.type === 'subtask') {
          await sendSubtaskStarted(part.description, part.agent, part.prompt);
        }
        break;
      }
      case 'session.created':
      case 'session.updated': {
        const info = event.properties?.info;
        if (info?.id && info?.title) sessionTitles.set(info.id, info.title);
        break;
      }
      case 'session.error': {
        const { sessionID, error } = event.properties ?? {};
        if (!error) break;
        let msg = 'Unknown error';
        if (typeof error === 'string') msg = error;
        else if (error?.data?.message) msg = String(error.data.message);
        else if (error?.message) msg = String(error.message);
        await sendError(msg, sessionID);
        break;
      }
    }
  } catch (e: any) {
    console.error('[telegram-notify] event failed:', e.message);
  }
}
