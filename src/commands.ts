import { execFile } from 'child_process';
import { promisify } from 'util';
import { registerPluginCommand } from './sdk/plugin-runtime';
import { existsSync } from 'fs';
import { sendMediaToCurrentChat } from './runtime/telegram-bot';

const execFileAsync = promisify(execFile);

// Same gate as the AI handler: only these Telegram user IDs may use shell tools.
const ALLOWED_USERS = (process.env.ALLOWED_TELEGRAM_USERS || '791865934')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const CWD = process.env.OPENCODE_CWD || '/Users/gutchapa';
const HOME = process.env.HOME || '/Users/gutchapa';

function isAllowed(user: string): boolean {
  return ALLOWED_USERS.includes(user);
}

function truncate(text: string, max = 4000): string {
  return text.length > max ? text.slice(0, max) + '\n\n…(truncated)' : text;
}

function resolvePath(p: string): string {
  if (p === '~') {
    return HOME;
  }
  if (p.startsWith('~/')) {
    return HOME + p.slice(1);
  }
  if (p.startsWith('/')) {
    return p;
  }
  return CWD + '/' + p;
}

export function setupCommands(): void {
  registerPluginCommand('*', 'send', async (user, cmd, args) => {
    if (!isAllowed(user)) return 'Not authorized.';
    if (!args.trim()) return 'Usage: /send <file path>';
    const p = resolvePath(args.trim().replace(/^["']|["']$/g, ''));
    if (!existsSync(p)) return `File not found: ${p}`;
    try {
      await sendMediaToCurrentChat(p);
      return `Sent \uD83D\uDCCE ${p}`;
    } catch (e: any) {
      return `Failed to send: ${e.message}`;
    }
  });
  registerPluginCommand('*', 'execute', async (user, cmd, args) => {
    if (!isAllowed(user)) return 'Not authorized.';
    const command = args.trim();
    if (!command) return 'Usage: /execute <shell command>';
    try {
      const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
        cwd: CWD,
        timeout: 60000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const out = (stdout + (stderr ? '\n[stderr] ' + stderr : '')).trim();
      return truncate(out || '(no output)');
    } catch (error: any) {
      const detail = (error.stderr || error.message || '').trim();
      return truncate(`Error: ${detail}` || 'Command failed');
    }
  });

  registerPluginCommand('*', 'read', async (user, cmd, args) => {
    if (!isAllowed(user)) return 'Not authorized.';
    const filePath = args.trim();
    if (!filePath) return 'Usage: /read <path>';
    try {
      const { readFile } = await import('fs/promises');
      const content = await readFile(resolvePath(filePath), 'utf-8');
      return truncate(content);
    } catch (error: any) {
      return `Error reading file: ${error.message}`;
    }
  });

  registerPluginCommand('*', 'search', async (user, cmd, args) => {
    if (!isAllowed(user)) return 'Not authorized.';
    const parts = args.trim().split(/\s+/);
    if (!parts[0]) return 'Usage: /search <pattern> [path]';
    const pattern = parts[0];
    const target = resolvePath(parts.slice(1).join(' ') || '.');
    try {
      const { stdout } = await execFileAsync(
        'grep',
        ['-rnI', '--exclude-dir=node_modules', '--exclude-dir=.git', pattern, target],
        { cwd: CWD, timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      );
      const lines = stdout.trim().split('\n').slice(0, 40).join('\n');
      return truncate(lines || '(no matches)');
    } catch (error: any) {
      // grep exits 1 when there are no matches.
      if (error.code === 1) return '(no matches)';
      return truncate(`Error: ${error.message}`);
    }
  });

  registerPluginCommand('*', 'list', async (user, cmd, args) => {
    if (!isAllowed(user)) return 'Not authorized.';
    const target = resolvePath(args.trim() || '.');
    try {
      const { readdir } = await import('fs/promises');
      const entries = await readdir(target, { withFileTypes: true });
      const lines = entries
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        .sort()
        .slice(0, 100)
        .join('\n');
      return truncate(lines || '(empty)');
    } catch (error: any) {
      return `Error listing: ${error.message}`;
    }
  });
}
