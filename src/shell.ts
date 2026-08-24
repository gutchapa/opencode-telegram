import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const CWD = process.env.OPENCODE_CWD || '/Users/gutchapa';

export function truncate(text: string, max = 4000): string {
  return text.length > max ? text.slice(0, max) + '\n\n…(truncated)' : text;
}

export async function runShell(cmd: string): Promise<string> {
  if (!cmd.trim()) return 'Usage: /exec <command>';
  const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', cmd], {
    cwd: CWD,
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return truncate((stdout + (stderr ? `\n${stderr}` : '')).trim() || '(no output)');
}
