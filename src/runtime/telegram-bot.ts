import { getBotToken } from '../sdk/provider-auth';
import { handleCommand } from './command-handler';
import { getAgentState } from '../agent-state';
import { syncTelegramMenuCommands } from '../telegram-menu';
import https from 'https';
import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';

let botStarted = false;
let lastUpdateId = 0;

// Persist the Telegram update offset so a restart does not re-fetch (and
// re-answer) up to 24h of backed-up updates.
import { join as joinPath } from 'path';
import { existsSync as fsExists, mkdirSync as fsMkdir, readFileSync as fsRead, writeFileSync as fsWrite } from 'fs';

function offsetFile(): string | null {
  try {
    const dir = joinPath(process.env.HOME || '/Users/gutchapa', '.opencode-telegram-state');
    fsMkdir(dir, { recursive: true });
    return joinPath(dir, 'last-update-id');
  } catch {
    return null;
  }
}
const OFFSET_FILE = offsetFile();
try {
  if (OFFSET_FILE && fsExists(OFFSET_FILE)) {
    const n = Number(fsRead(OFFSET_FILE, 'utf-8').trim());
    if (Number.isFinite(n) && n >= 0) lastUpdateId = n;
  }
} catch {
  /* start from 0 on any read failure */
}
function saveOffset(): void {
  try {
    if (OFFSET_FILE) fsWrite(OFFSET_FILE, String(lastUpdateId));
  } catch {
    /* offset persistence is best-effort */
  }
}

function isAllowedUser(userId: string): boolean {
  const allowed = (process.env.ALLOWED_TELEGRAM_USERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(userId);
}

// Voice notes, audio files, video notes, captioned photos and documents
// arrive without message.text. Transcribe or describe them into text so the
// normal command/AI flow can handle them. Returns '' when there is nothing
// answerable (strangers' media is skipped silently to avoid CPU abuse).
async function resolveNonTextMessage(msg: any, userId: string, chatId: number): Promise<string> {
  const voice = msg.voice || msg.audio || msg.video_note;
  if (voice?.file_id) {
    if (!isAllowedUser(userId)) {
      return '';
    }
    sendChatAction(chatId, 'typing').catch(() => {});
    try {
      const { transcribeVoice } = await import('../voice');
      const transcript = await transcribeVoice({ fileId: voice.file_id, duration: voice.duration });
      console.log(`Voice transcribed (${transcript.length} chars)`);
      return transcript;
    } catch (e: any) {
      console.error('Voice transcription failed:', e.message);
      await sendTelegramMessage(chatId, `Couldn't transcribe that voice note: ${e.message}`).catch(() => {});
      return '';
    }
  }
  if (msg.caption) {
    return msg.caption;
  }
  if (msg.photo || msg.document || msg.location || msg.sticker) {
    if (!isAllowedUser(userId)) {
      return '';
    }
    await sendTelegramMessage(
      chatId,
      'I can read text, captions and voice notes — but not bare photos, files or locations yet. Add a caption or send a voice note.',
    ).catch(() => {});
    return '';
  }
  return '';
}

function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const token = getBotToken();
    const postData = JSON.stringify({
      chat_id: chatId,
      text: text,
    });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.ok) {
            resolve();
          } else {
            reject(new Error(response.description || 'Failed to send message'));
          }
        } catch (error: any) {
          reject(error);
        }
      });
    });
    req.on('error', (error: any) => {
      reject(error);
    });
    req.write(postData);
    req.end();
  });
}

// --- Media sending support ---
// activeChatId is persisted to disk so a restart does not lose the digest
// target: without this, the daily digest waits for the user to message
// first, while the user waits for the digest (catch-22).
const ACTIVE_CHAT_FILE = joinPath(process.env.HOME || '/Users/gutchapa', '.opencode-telegram-state', 'active-chat-id');
let activeChatId: number | null = null;
try {
  if (fsExists(ACTIVE_CHAT_FILE)) {
    const n = Number(fsRead(ACTIVE_CHAT_FILE, 'utf-8').trim());
    if (Number.isFinite(n) && n > 0) {
      activeChatId = n;
      console.log(`Restored active chat ${n} from disk`);
    }
  }
} catch { /* start with no chat on any read failure */ }
function setActiveChat(chatId: number): void {
  activeChatId = chatId;
  try {
    fsMkdir(joinPath(process.env.HOME || '/Users/gutchapa', '.opencode-telegram-state'), { recursive: true });
    fsWrite(ACTIVE_CHAT_FILE, String(chatId));
  } catch { /* persistence is best-effort */ }
}
export function getActiveChat(): number | null {
  return activeChatId;
}
export function sendTextToChat(chatId: number, text: string): Promise<void> {
  return sendTelegramMessage(chatId, text);
}

function inferMediaKind(filePath: string): 'photo' | 'video' | 'document' {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext)) return 'photo';
  if (['mp4', 'mov', 'mkv'].includes(ext)) return 'video';
  return 'document';
}

function sendTelegramMedia(chatId: number, filePath: string, kind: 'photo' | 'video' | 'document' | 'animation' | 'audio', caption?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const token = getBotToken();
    if (!token) {
      reject(new Error('No bot token found'));
      return;
    }
    let file: Buffer;
    try {
      file = readFileSync(filePath);
    } catch (e: any) {
      reject(e);
      return;
    }
    const filename = basename(filePath);
    const boundary = '----gutchapa' + Date.now().toString(16);
    const fieldParts: Buffer[] = [];
    const fields: Array<[string, string]> = [['chat_id', String(chatId)]];
    if (caption) fields.push(['caption', caption]);
    for (const [name, value] of fields) {
      fieldParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    const fileHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${kind}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([...fieldParts, fileHeader, file, footer]);
    const method = 'send' + kind.charAt(0).toUpperCase() + kind.slice(1);
    const options: any = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.ok) resolve();
          else reject(new Error(response.description || 'Failed to send media'));
        } catch (e: any) {
          reject(e);
        }
      });
    });
    req.on('error', (error: any) => {
      reject(error);
    });
    req.write(body);
    req.end();
  });
}

export function sendMediaToCurrentChat(filePath: string, kind?: 'photo' | 'video' | 'document' | 'animation' | 'audio', caption?: string): Promise<void> {
  if (activeChatId == null) return Promise.reject(new Error('No active chat'));
  return sendTelegramMedia(activeChatId, filePath, kind ?? inferMediaKind(filePath), caption);
}

function sendChatAction(chatId: number, action: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const token = getBotToken();
    const postData = JSON.stringify({
      chat_id: chatId,
      action: action,
    });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendChatAction`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.ok) {
            resolve();
          } else {
            reject(new Error(response.description || 'Failed to send chat action'));
          }
        } catch (error: any) {
          reject(error);
        }
      });
    });
    req.on('error', (error: any) => {
      reject(error);
    });
    req.write(postData);
    req.end();
  });
}

export async function startBot(): Promise<void> {
  if (botStarted) {
    console.log('Bot already started');
    return;
  }

  const token = getBotToken();
  if (!token) {
    console.error('No bot token found');
    return;
  }

  console.log('Starting bot with token:', token.substring(0, 10) + '...');

  // Guard against overlapping polls: a slow response must not trigger a
  // second fetch of the same updates (duplicate replies).
  let pollInFlight = false;
  const pollingInterval = setInterval(async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    const release = () => {
      pollInFlight = false;
    };
    try {
      const token = getBotToken();
      const path = `/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`;

      const options = {
        hostname: 'api.telegram.org',
        path: path,
        method: 'GET',
        headers: {
          'User-Agent': 'opencode-Telegram-Plugin/1.0',
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', async () => {
          release();
          try {
            const response = JSON.parse(data);
            if (response.ok && Array.isArray(response.result) && response.result.length > 0) {
              for (const update of response.result) {
                console.log('Processing update:', JSON.stringify(update, null, 2));
                lastUpdateId = Math.max(lastUpdateId, update.update_id);
                saveOffset();
                if (update.message) {
                  const chatId = update.message.chat.id;
                  setActiveChat(chatId);
                  const username = update.message.from ? update.message.from.username : '';
                  const userId = update.message.from ? update.message.from.id.toString() : '';
                  let text = update.message.text ?? '';
                  if (!text) {
                    text = await resolveNonTextMessage(update.message, userId, chatId);
                    if (!text) {
                      continue;
                    }
                  }

                  console.log('Received message from:', username, 'ID:', userId, 'Text:', text);

                  if (
                    getAgentState().activation === 'mention' &&
                    (!text || !/@gutchapaopenbot|gutchapaopenbot|\bbot\b/i.test(text))
                  ) {
                    continue; // mention mode: ignore messages not addressed to the bot
                  }

                  const result = handleCommand(userId, username, text);
                  // Show the "typing..." indicator while the LLM generates;
                  // Telegram clears it after ~5s, so re-send every 4s.
                  const typingInterval = setInterval(() => {
                    sendChatAction(chatId, 'typing').catch(() => {});
                  }, 4000);
                  sendChatAction(chatId, 'typing').catch(() => {});
                  result.then((response) => {
                    clearInterval(typingInterval);
                    if (response) {
                      const trimmedResponse = response.trim();
                      // Auto-send files ONLY for allowed users: otherwise any
                      // stranger whose reply happens to equal a file path would
                      // pull arbitrary files off this Mac.
                      if (isAllowedUser(userId) && existsSync(trimmedResponse)) {
                        sendMediaToCurrentChat(trimmedResponse).catch((err: any) => {
                          console.error('Failed to auto-send media:', err.message);
                        });
                      }
                      console.log('Sending response:', response);
                      sendTelegramMessage(chatId, response).catch((err) => {
                        console.error('Failed to send response:', err.message);
                      });
                    }
                  }).catch((err) => {
                    clearInterval(typingInterval);
                    console.error('Error handling command:', err.message);
                  });
                }
              }
            }
          } catch (error: any) {
            console.error('Error parsing update:', error.message, data);
          }
        });
      });

      req.on('error', (error: any) => {
        release();
        console.error('Error fetching updates:', error.message);
      });

      req.end();
    } catch (error: any) {
      release();
      console.error('Error in polling:', error.message);
    }
  }, 5000); // Poll every 5 seconds

  console.log('Bot started - polling for messages every 5 seconds');
  botStarted = true;

  // Register the slash commands with Telegram so typing "/"
  // shows the command menu.
  syncTelegramMenuCommands().catch((err: any) => {
    console.error('Failed to sync Telegram command menu:', err.message);
  });

  // Cleanup on exit
  process.on('SIGINT', () => {
    console.log('Shutting down bot...');
    clearInterval(pollingInterval);
    botStarted = false;
    process.exit(0);
  });
}


