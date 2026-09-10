import { execFile } from 'child_process';
import { promisify } from 'util';
import { createWriteStream, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import https from 'https';
import { getBotToken } from './sdk/provider-auth';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || '/opt/homebrew/bin/whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL || '/Users/gutchapa/tools/whisper.cpp/models/ggml-base.en.bin';
const FFMPEG_BIN = process.env.FFMPEG_BIN || '/opt/homebrew/bin/ffmpeg';
// Upper bound: Telegram voice notes can be long; cap to keep CPU bounded.
const MAX_VOICE_SECONDS = Number(process.env.MAX_VOICE_SECONDS || 300);
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS || 120000);

export interface VoiceFile {
  fileId: string;
  duration?: number;
}

function botGet<T>(path: string): Promise<T> {
  const token = getBotToken();
  return new Promise((resolve, reject) => {
    https
      .get(`https://api.telegram.org/bot${token}/${path}`, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            if (j.ok) resolve(j.result as T);
            else reject(new Error(j.description || 'Telegram API error'));
          } catch (e: any) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function downloadFile(filePath: string, dest: string): Promise<void> {
  const token = getBotToken();
  return new Promise((resolve, reject) => {
    const out = createWriteStream(dest);
    https
      .get(`https://api.telegram.org/file/bot${token}/${filePath}`, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`file download HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(out);
        out.on('finish', () => resolve());
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

export function parseTranscript(output: string): string {
  // Segment lines look like "[00:00:11.000 --> 00:00:14.000]  text".
  // Everything else (backend init, timings) is log noise.
  return output
    .split('\n')
    .map((l) => {
      const m = l.match(/\[\d\d:\d\d:\d\d\.\d\d+ --> \d\d:\d\d:\d\d\.\d\d+\]\s*(.*)/);
      return m ? m[1].trim() : null;
    })
    .filter((t): t is string => !!t)
    .join(' ')
    .trim();
}

export async function transcribeVoice(file: VoiceFile): Promise<string> {
  if (!existsSync(WHISPER_BIN)) {
    throw new Error('voice transcription unavailable (whisper-cli not installed)');
  }
  if (!existsSync(WHISPER_MODEL)) {
    throw new Error('voice transcription unavailable (whisper model missing)');
  }
  if (file.duration && file.duration > MAX_VOICE_SECONDS) {
    throw new Error(`voice note too long (${file.duration}s > ${MAX_VOICE_SECONDS}s cap)`);
  }
  const meta = await botGet<{ file_path?: string }>(
    `getFile?file_id=${encodeURIComponent(file.fileId)}`,
  );
  if (!meta.file_path) {
    throw new Error('Telegram returned no file path for the voice note');
  }
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const src = join(tmpdir(), `tg-voice-${stamp}.oga`);
  const wav = join(tmpdir(), `tg-voice-${stamp}.wav`);
  try {
    await downloadFile(meta.file_path, src);
    await execFileAsync(FFMPEG_BIN, ['-y', '-loglevel', 'error', '-i', src, '-ar', '16000', '-ac', '1', wav], {
      timeout: 60000,
    });
    const { stdout } = await execFileAsync(WHISPER_BIN, ['-m', WHISPER_MODEL, wav], {
      timeout: TRANSCRIBE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const text = parseTranscript(stdout);
    if (!text) {
      throw new Error('transcription came back empty (no speech detected?)');
    }
    return text;
  } finally {
    try {
      unlinkSync(src);
    } catch { /* ignore */ }
    try {
      unlinkSync(wav);
    } catch { /* ignore */ }
  }
}
