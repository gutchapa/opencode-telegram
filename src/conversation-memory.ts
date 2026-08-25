import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_TURNS = 20;
const MAX_TOTAL_CHARS = 16000;

const STATE_DIR = join(process.env.HOME || '/Users/gutchapa', '.opencode-telegram-state');
const STATE_FILE = join(STATE_DIR, 'history.json');

const memory = new Map<string, HistoryEntry[]>();

function loadMemory(): void {
  try {
    if (!existsSync(STATE_FILE)) return;
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    if (raw && typeof raw === 'object') {
      for (const [user, entries] of Object.entries(raw)) {
        if (Array.isArray(entries)) {
          memory.set(user, entries as HistoryEntry[]);
        }
      }
    }
  } catch (error) {
    console.error('Failed to load conversation history:', error);
  }
}

function persistMemory(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const data: Record<string, HistoryEntry[]> = {};
    for (const [user, entries] of memory) data[user] = entries;
    writeFileSync(STATE_FILE, JSON.stringify(data));
  } catch (error) {
    console.error('Failed to save conversation history:', error);
  }
}

loadMemory();

export function appendMessage(user: string, role: HistoryEntry['role'], content: string): void {
  const trimmed = content.trim();
  if (!trimmed) return;
  const entries = memory.get(user) || [];
  entries.push({ role, content: trimmed });
  while (entries.length > MAX_TURNS) entries.shift();
  let total = entries.reduce((n, e) => n + e.content.length, 0);
  while (total > MAX_TOTAL_CHARS && entries.length > 1) {
    total -= (entries.shift() as HistoryEntry).content.length;
  }
  memory.set(user, entries);
  persistMemory();
}

export function getHistory(user: string): HistoryEntry[] {
  return memory.get(user) || [];
}

export function clearHistory(user: string): void {
  memory.delete(user);
  persistMemory();
}

export function formatTranscript(history: HistoryEntry[]): string {
  if (!history.length) return '';
  return history
    .map((e) => `${e.role === 'user' ? 'User' : 'Assistant'}: ${e.content}`)
    .join('\n');
}
