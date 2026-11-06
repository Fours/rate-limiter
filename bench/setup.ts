// What every results directory records about where its numbers came from, so they can be rerun
// or judged. Leaves out the hostname, which can identify you.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');

/** The date, command, git state and host, shared by `npm run bench` and `npm run bench:memory`. */
export function baseSetup(command: string): Record<string, unknown> {
  const cpus = os.cpus();
  return {
    date: new Date().toISOString(),
    command,
    git: {
      commit: sh('git', ['rev-parse', 'HEAD']).trim(),
      uncommittedChanges: sh('git', ['status', '--porcelain']).trim() !== '',
    },
    host: {
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: cpus[0]?.model ?? 'unknown',
      cores: cpus.length,
      memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    },
  };
}

/** Runs a command from the repo root and returns its stdout. Its stderr goes to the terminal. */
export function sh(cmd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 256 * 1024 * 1024,
  });
}
