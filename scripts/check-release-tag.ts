// Refuses to release unless the pushed tag names exactly the version in package.json, so a tag
// can never publish a version nobody meant to (decision 0025).
//
// Usage: node --experimental-strip-types scripts/check-release-tag.ts <tag>
// In release.yml the tag is GITHUB_REF_NAME, such as v1.0.0.
import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Why `tag` can't release `version`, or `undefined` if it can. */
export function releaseTagProblem(tag: string, version: string): string | undefined {
  // release.yml publishes to the `latest` dist-tag, so a prerelease would become what
  // `npm install` gets. Refuse it until the workflow learns to publish under another dist-tag.
  if (version.includes('-')) {
    return `package.json's version ${version} is a prerelease, and this workflow only publishes to latest`;
  }
  if (tag !== `v${version}`) {
    return `tag ${tag} doesn't match package.json's version ${version}: expected v${version}`;
  }
  return undefined;
}

function main(tag: string | undefined): void {
  if (tag === undefined || tag === '') {
    console.error('Usage: check-release-tag.ts <tag>');
    process.exit(2);
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  const problem = releaseTagProblem(tag, pkg.version);
  if (problem !== undefined) {
    // An annotation, so the refusal shows on the run's summary page.
    console.error(`::error title=Release refused::${problem}`);
    process.exit(1);
  }
  console.log(`Tag ${tag} matches package.json's version ${pkg.version}.`);
}

// Run only as a script, so tests can import releaseTagProblem without side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]);
}
