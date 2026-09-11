import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execFileAsync = promisify(execFile);
const CWD = process.env.OPENCODE_CWD || '/Users/gutchapa';

// Resolve a working shell at runtime instead of trusting any single path:
// /bin/sh has been observed missing on some CI images, and bare 'sh' can
// fail PATH lookup in sandboxed runners. First existing binary wins.
const SHELL_CANDIDATES = ['/bin/sh', '/usr/bin/sh', 'sh', '/bin/bash', '/usr/bin/bash', 'bash'];
export function resolveShell(): string {
  for (const c of SHELL_CANDIDATES) {
    if (!c.includes('/') || existsSync(c)) return c;
  }
  return 'sh';
}

export function truncate(text: string, max = 4000): string {
  return text.length > max ? text.slice(0, max) + '\n\n…(truncated)' : text;
}

export async function runShell(cmd: string): Promise<string> {
  if (!cmd.trim()) return 'Usage: /exec <command>';
  const { stdout, stderr } = await execFileAsync(resolveShell(), ['-c', cmd], {
    cwd: CWD,
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return truncate((stdout + (stderr ? `\n${stderr}` : '')).trim() || '(no output)');
}
