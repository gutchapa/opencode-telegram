import { getBotToken } from '../sdk/provider-auth';
import { handleCommand } from './command-handler';
import { getAgentState } from '../agent-state';
import { syncTelegramMenuCommands } from '../telegram-menu';
import https from 'https';

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
