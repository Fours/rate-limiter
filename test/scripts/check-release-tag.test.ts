import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { releaseTagProblem } from '../../scripts/check-release-tag.ts';

describe('releaseTagProblem', () => {
  it('accepts the tag v<version>', () => {
    expect(releaseTagProblem('v1.0.0', '1.0.0')).toBeUndefined();
    expect(releaseTagProblem('v12.3.45', '12.3.45')).toBeUndefined();
  });

  it.each([
    ['another version', 'v1.0.1', '1.0.0'],
    ['no leading v', '1.0.0', '1.0.0'],
    ['a capital V', 'V1.0.0', '1.0.0'],
    ['a prefix of the version', 'v1.0', '1.0.0'],
    ['the version with more after it', 'v1.0.00', '1.0.0'],
    ['a prerelease tag on a release version', 'v1.0.0-rc.1', '1.0.0'],
    ['a branch-like name', 'release', '1.0.0'],
  ])('refuses %s', (_, tag, version) => {
    expect(releaseTagProblem(tag, version)).toMatch(/doesn't match.*expected v1\.0\.0/);
  });

  it('refuses a prerelease version, even with its matching tag', () => {
    expect(releaseTagProblem('v1.1.0-rc.1', '1.1.0-rc.1')).toMatch(/prerelease/);
  });
});

// The workflow runs it as a script, so check the exit codes it actually gives.
describe('check-release-tag.ts as a script', () => {
  const run = (...args: string[]) => {
    try {
      execFileSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          'scripts/check-release-tag.ts',
          ...args,
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      return 0;
    } catch (error) {
      return (error as { status: number }).status;
    }
  };
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

  it("exits 0 for this package.json's version", () => {
    expect(run(`v${version}`)).toBe(0);
  });

  it('exits 1 for another version', () => {
    expect(run('v0.0.0')).toBe(1);
  });

  it('exits 2 without a tag', () => {
    expect(run()).toBe(2);
    expect(run('')).toBe(2);
  });
});
