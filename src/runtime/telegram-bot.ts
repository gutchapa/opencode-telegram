import { getBotToken } from '../sdk/provider-auth';
import { handleCommand } from './command-handler';
import { getAgentState } from '../agent-state';
import { syncTelegramMenuCommands } from '../telegram-menu';
import https from 'https';
import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';

let botStarted = false;
let lastUpdateId = 0;

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
let activeChatId: number | null = null;
export function setActiveChat(chatId: number): void {
  activeChatId = chatId;
}
export function getActiveChat(): number | null {
  return activeChatId;
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

  const pollingInterval = setInterval(async () => {
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
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.ok && Array.isArray(response.result) && response.result.length > 0) {
              for (const update of response.result) {
                console.log('Processing update:', JSON.stringify(update, null, 2));
                lastUpdateId = Math.max(lastUpdateId, update.update_id);
                if (update.message) {
                  const chatId = update.message.chat.id;
                  setActiveChat(chatId);
                  const text = update.message.text;
                  const username = update.message.from ? update.message.from.username : '';
                  const userId = update.message.from ? update.message.from.id.toString() : '';

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
                      if (existsSync(trimmedResponse)) {
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
        console.error('Error fetching updates:', error.message);
      });

      req.end();
    } catch (error: any) {
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

export function stopBot(): void {
  if (botStarted) {
    console.log('Stopping bot...');
    botStarted = false;
  }
}

export function isBotStarted(): boolean {
  return botStarted;
}
