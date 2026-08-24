// Per-user rolling conversation memory so follow-up messages have context.
// The bot used to treat every message as a fresh stateless turn; now each
// chat keeps a bounded recent transcript that is injected into the prompt.

export interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_TURNS = 20; // max stored entries per user (user + assistant pairs)
const MAX_TOTAL_CHARS = 16000; // safety cap: drop oldest entries past this

const memory = new Map<string, HistoryEntry[]>();

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
}

export function getHistory(user: string): HistoryEntry[] {
  return memory.get(user) || [];
}

export function clearHistory(user: string): void {
  memory.delete(user);
}

// Renders the transcript as a plain-text dialogue for injection into prompts.
export function formatTranscript(history: HistoryEntry[]): string {
  if (!history.length) return '';
  return history
    .map((e) => `${e.role === 'user' ? 'User' : 'Assistant'}: ${e.content}`)
    .join('\n');
}
