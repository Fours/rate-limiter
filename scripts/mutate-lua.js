// Mutation testing for the Lua scripts, npm run mutate:lua (decision 0033). Stryker only mutates
// JavaScript and TypeScript, and the scripts hold most of the algorithms' logic. This applies
// the same kinds of small changes to each .lua file, one at a time, and runs that algorithm's
// integration tests against each. A mutant the tests don't notice is a gap, or an equivalent
// change that needs a reason. Needs the test Redis (npm run redis:up).
//
//   npm run mutate:lua                    every script
//   npm run mutate:lua -- token-bucket    one script, by name
//   npm run mutate:lua -- --list          list the mutants without running anything
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const DIR = 'src/algorithms/redis';
const ALGORITHMS = [
  'token-bucket',
  'leaky-bucket',
  'fixed-window',
  'sliding-window-log',
  'sliding-window-counter',
];
// Tests that run every algorithm, as well as each one's own file.
const SHARED_TESTS = [
  'test/integration/extreme-rules.test.ts',
  'test/integration/middleware.test.ts',
];

const testsFor = (name) =>
  name === 'prelude'
    ? [
        'test/integration/prelude.test.ts',
        ...ALGORITHMS.map((a) => `test/integration/algorithms/${a}.test.ts`),
        ...SHARED_TESTS,
      ]
    : [`test/integration/algorithms/${name}.test.ts`, ...SHARED_TESTS];

// [label, pattern, replacement]. Each match is its own mutant. Patterns run on code with comments
// removed and string literals blanked, so they can't change either.
const OPERATORS = [
  ['<= to <', /<=/g, '<'],
  ['>= to >', />=/g, '>'],
  ['< to <=', /<(?!=)/g, '<='],
  ['> to >=', />(?!=)/g, '>='],
  ['== to ~=', /==/g, '~='],
  ['~= to ==', /~=/g, '=='],
  ['+ to -', / \+ /g, ' - '],
  ['- to +', / - /g, ' + '],
  ['* to /', / \* /g, ' / '],
  ['/ to *', / \/ /g, ' * '],
  ['floor to ceil', /math\.floor/g, 'math.ceil'],
  ['ceil to floor', /math\.ceil/g, 'math.floor'],
  ['max to min', /math\.max/g, 'math.min'],
  ['min to max', /math\.min/g, 'math.max'],
  ['and to or', / and /g, ' or '],
  ['or to and', / or /g, ' and '],
  ['drop not', /\bnot /g, ''],
  ['n to n + 1', /(?<![\w.])\d+(?![\w.])/g, (n) => String(Number(n) + 1)],
];

/** The line's code, with any comment cut off and string contents blanked to spaces. */
function maskLine(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== null) {
      out += c === quote ? c : ' ';
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
      out += c;
    } else if (c === '-' && line[i + 1] === '-') {
      break;
    } else {
      out += c;
    }
  }
  return out;
}

function mutantsOf(source) {
  const lines = source.split('\n');
  const mutants = [];
  lines.forEach((line, index) => {
    const code = maskLine(line);
    for (const [label, pattern, replacement] of OPERATORS) {
      for (const match of code.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        const text = typeof replacement === 'function' ? replacement(match[0]) : replacement;
        const mutated = line.slice(0, start) + text + line.slice(end);
        mutants.push({
          line: index + 1,
          label,
          original: line.trim(),
          mutated: mutated.trim(),
          apply: () => withLine(lines, index, mutated),
        });
      }
    }
    // Deleting a whole write: a missing HSET, PEXPIRE or ZADD should always be caught.
    const trimmed = code.trim();
    if (/^redis\.call\(/.test(trimmed) && balanced(trimmed)) {
      mutants.push({
        line: index + 1,
        label: 'delete call',
        original: line.trim(),
        mutated: '(deleted)',
        apply: () => withLine(lines, index, ''),
      });
    }
  });
  return mutants;
}

function balanced(code) {
  let depth = 0;
  for (const c of code) depth += c === '(' ? 1 : c === ')' ? -1 : 0;
  return depth === 0;
}

function withLine(lines, index, text) {
  const copy = [...lines];
  copy[index] = text;
  return copy.join('\n');
}

function runTests(files) {
  const result = spawnSync(
    'npx',
    ['vitest', 'run', '--project', 'integration', '--bail=1', ...files],
    { encoding: 'utf8', timeout: 180_000 },
  );
  const output = `${result.stdout}${result.stderr}`;
  if (result.error?.code === 'ETIMEDOUT') return { status: 'timeout', output };
  if (result.status === 0) return { status: 'survived', output };
  // A script Redis can't compile isn't a bug the tests caught: Lua refused it.
  const invalid = /Error compiling script|user_script:\d+: .*(near|expected)/.test(output);
  return { status: invalid ? 'invalid' : 'killed', output };
}

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const only = args.filter((a) => !a.startsWith('--'));
const names = only.length > 0 ? only : ['prelude', ...ALGORITHMS];

const report = [];
for (const name of names) {
  const path = `${DIR}/${name}.lua`;
  const original = readFileSync(path, 'utf8');
  const mutants = mutantsOf(original);
  console.log(`${name}: ${String(mutants.length)} mutants`);
  if (listOnly) {
    for (const m of mutants) console.log(`  ${String(m.line)}: ${m.label}: ${m.mutated}`);
    continue;
  }
  // Restore the script however this process ends, so a mutant is never left in src/.
  const restore = () => writeFileSync(path, original);
  process.once('SIGINT', () => {
    restore();
    process.exit(130);
  });
  try {
    // The unmutated script must pass, or every mutant would look killed. Once more on a failure,
    // since a timing test can flake under load, then stop with the output.
    const baseline = [runTests(testsFor(name))];
    if (baseline[0]?.status !== 'survived') baseline.push(runTests(testsFor(name)));
    const last = baseline.at(-1);
    if (last?.status !== 'survived') {
      console.error(last?.output);
      throw new Error(`${name}: the tests fail before any mutation`);
    }
    for (const [i, m] of mutants.entries()) {
      writeFileSync(path, m.apply());
      const { status } = runTests(testsFor(name));
      report.push({
        file: path,
        line: m.line,
        label: m.label,
        original: m.original,
        mutated: m.mutated,
        status,
      });
      if (status === 'survived')
        console.log(`  SURVIVED ${path}:${String(m.line)} ${m.label}: ${m.mutated}`);
      process.stdout.write(`  ${String(i + 1)}/${String(mutants.length)}\r`);
    }
  } finally {
    restore();
  }
}

if (!listOnly) {
  mkdirSync('reports/mutation', { recursive: true });
  writeFileSync('reports/mutation/lua.json', `${JSON.stringify(report, null, 2)}\n`);
  const count = (s) => report.filter((r) => r.status === s).length;
  const valid = report.length - count('invalid');
  const caught = count('killed') + count('timeout');
  console.log(
    `\n${String(report.length)} mutants: ${String(count('killed'))} killed, ${String(count('timeout'))} timed out, ` +
      `${String(count('survived'))} survived, ${String(count('invalid'))} invalid Lua. ` +
      `Score ${(valid === 0 ? 0 : (100 * caught) / valid).toFixed(1)}%. Details in reports/mutation/lua.json.`,
  );
}
