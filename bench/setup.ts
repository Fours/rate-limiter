// What every results directory records about where its numbers came from, so they can be rerun
// or judged. Leaves out the hostname, which can identify you.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
/** Where benchmark results go, relative to ROOT. Untracked output there is not a code change. */
export const DATA_PATHS = ['docs/decisions/data', 'bench/results'];

/** The date, command, git state and host, shared by `npm run bench` and `npm run bench:memory`. */
export function baseSetup(command: string): Record<string, unknown> {
  const cpus = os.cpus();
  return {
    date: new Date().toISOString(),
    command,
    git: {
      commit: sh('git', ['rev-parse', 'HEAD']).trim(),
      uncommittedChanges: hasUncommittedChanges(),
    },
    host: {
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: cpus[0]?.model ?? 'unknown',
      cores: cpus.length,
      memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    },
  };
}

/**
 * Whether the checkout differs from HEAD, tracked or untracked, outside the results directories.
 * A full run's own output is untracked until it's committed, so counting it flagged every run
 * as uncommitted (found in T5).
 */
export function hasUncommittedChanges(cwd: string = ROOT): boolean {
  const exclude = DATA_PATHS.map((p) => `:!${p}`);
  const status = execFileSync('git', ['status', '--porcelain', '--', '.', ...exclude], {
    cwd,
    encoding: 'utf8',
  });
  return status.trim() !== '';
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
