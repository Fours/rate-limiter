import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasUncommittedChanges } from '../../bench/setup.ts';

describe('hasUncommittedChanges', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'bench-git-'));
    git('init', '-q');
    await writeFile(join(repo, 'a.ts'), 'one\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('is false for a clean checkout', () => {
    expect(hasUncommittedChanges(repo)).toBe(false);
  });

  it("ignores untracked results, which a full run writes before it's committed", async () => {
    await mkdir(join(repo, 'docs/decisions/data/0008-steady-x'), { recursive: true });
    await writeFile(join(repo, 'docs/decisions/data/0008-steady-x/setup.json'), '{}\n');
    await mkdir(join(repo, 'bench/results/q'), { recursive: true });
    await writeFile(join(repo, 'bench/results/q/meta.json'), '{}\n');
    expect(hasUncommittedChanges(repo)).toBe(false);
  });

  it('sees a modified tracked file', async () => {
    await writeFile(join(repo, 'a.ts'), 'two\n');
    expect(hasUncommittedChanges(repo)).toBe(true);
  });

  it('sees an untracked file outside the results, such as a new script', async () => {
    await mkdir(join(repo, 'bench'));
    await writeFile(join(repo, 'bench/new.ts'), 'x\n');
    expect(hasUncommittedChanges(repo)).toBe(true);
  });
});
