import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidRuleError } from '../src/rules.js';
import {
  loadRules,
  loadRulesWith,
  parseRules,
  parseRulesWith,
  type YamlImporter,
} from '../src/rules-file.js';
import type { Rule } from '../src/types.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'rules');
const fixture = (name: string) => join(fixtures, name);

const expected: Rule[] = [
  { id: 'global', limit: 100, windowMs: 60_000 },
  {
    id: 'orders:free',
    limit: 10,
    windowMs: 60_000,
    method: 'POST',
    path: '/orders/*',
    tier: 'free',
  },
];

/** Fails the way Node does when a package isn't installed (checked against Node 22). */
const yamlMissing: YamlImporter = () =>
  Promise.reject(
    Object.assign(new Error("Cannot find package 'yaml' imported from rules-file.js"), {
      code: 'ERR_MODULE_NOT_FOUND',
    }),
  );

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('loadRules', () => {
  it.each(['rules.json', 'rules.yaml', 'rules.yml'])(
    'loads the same rules from %s',
    async (name) => {
      await expect(loadRules(fixture(name))).resolves.toEqual(expected);
    },
  );

  it('accepts an empty rules list', async () => {
    await expect(loadRules(fixture('empty-list.json'))).resolves.toEqual([]);
    await expect(parseRules('rules: []', 'yaml')).resolves.toEqual([]);
  });

  it('rejects a missing file instead of returning no rules', async () => {
    const path = fixture('does-not-exist.yaml');
    const error = await rejection(loadRules(path));
    expect(error).toMatchObject({ code: 'ENOENT' });
    expect(error.message).toContain(path);
  });

  it('rejects an extension it cannot infer a format from', async () => {
    const error = await rejection(loadRules(fixture('rules.txt')));
    expect(error).toBeInstanceOf(InvalidRuleError);
    expect(error.message).toMatch(/rules\.txt: rules files must end in \.json, \.yaml or \.yml/);
  });

  it('names the file, position and id for an unknown field', async () => {
    const path = fixture('typo.yaml');
    const error = await rejection(loadRules(path));
    expect(error).toBeInstanceOf(InvalidRuleError);
    expect(error.message).toBe(
      `${path}: rules[1] ("orders"): unknown field "limt"; allowed fields are id, limit, windowMs, burst, method, path, tier`,
    );
  });

  it('treats an empty YAML file as missing the rules key', async () => {
    const path = fixture('empty.yaml');
    await expect(loadRules(path)).rejects.toThrow(`${path}: must be an object with a "rules" list`);
  });

  it('reads the extension case-insensitively', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rules-'));
    try {
      const path = join(dir, 'RULES.YML');
      await writeFile(path, 'rules: []');
      await expect(loadRules(path)).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('parseRules errors', () => {
  const src = 'config/rules.json';
  const json = (rules: unknown) => JSON.stringify({ rules });
  const good = { id: 'orders', limit: 10, windowMs: 1_000 };

  it.each([
    [
      'an unknown rule field',
      json([good, { ...good, id: 'b', methd: 'POST' }]),
      'rules[1] ("b"): unknown field "methd"',
    ],
    [
      'an unknown field on a rule with no id',
      json([{ limit: 1, windowMs: 1, extra: 1 }]),
      'rules[0]: unknown field "extra"',
    ],
    [
      'an unknown top-level field',
      JSON.stringify({ rules: [], rule: [] }),
      'top level: unknown field "rule"',
    ],
    [
      'a bad value',
      json([good, { ...good, id: 'b', limit: 0 }]),
      'rules[1] ("b"): limit must be a positive integer',
    ],
    [
      'a string where a number belongs',
      json([{ ...good, windowMs: '60s' }]),
      'rules[0] ("orders"): windowMs must be a positive integer',
    ],
    ['a rule that is not an object', json([good, 'oops']), 'rules[1]: must be an object'],
    ['a duplicate id', json([good, good]), 'rules[1] ("orders"): id is already used'],
    ['a missing rules key', '{}', 'must be an object with a "rules" list'],
    ['a null rules key', '{ "rules": null }', '"rules" must be a list'],
    ['a bare list', JSON.stringify([good]), 'must be an object with a "rules" list'],
    ['invalid JSON', '{ rules: [', 'not valid JSON'],
  ])('rejects %s, naming the source', async (_case, text, message) => {
    const error = await rejection(parseRules(text, 'json', src));
    expect(error).toBeInstanceOf(InvalidRuleError);
    expect(error.message).toContain(`${src}: ${message}`);
  });

  it('reads a burst, and rejects a bad one with the source and position', async () => {
    await expect(
      parseRules('rules:\n  - { id: a, limit: 100, windowMs: 60000, burst: 10 }', 'yaml'),
    ).resolves.toEqual([{ id: 'a', limit: 100, windowMs: 60_000, burst: 10 }]);
    await expect(
      parseRules(
        '{"rules":[{"id":"a","limit":100,"windowMs":60000,"burst":"10"}]}',
        'json',
        'r.json',
      ),
    ).rejects.toThrow('r.json: rules[0] ("a"): burst must be a positive integer');
  });

  it('leaves the source out when none is given', async () => {
    await expect(parseRules(json([{ ...good, limt: 1 }]), 'json')).rejects.toThrow(
      /^rules\[0\] \("orders"\): unknown field "limt"/,
    );
  });

  it('rejects invalid YAML, keeping the parser error as the cause', async () => {
    const error = await rejection(
      parseRules('rules:\n  - id: a\n  - id: a\n    id: b', 'yaml', 'r.yaml'),
    );
    expect(error).toBeInstanceOf(InvalidRuleError);
    expect(error.message).toMatch(/^r\.yaml: not valid YAML: Map keys must be unique/);
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe('without the yaml package', () => {
  it('says to install yaml when parsing YAML', async () => {
    const error = await rejection(parseRulesWith(yamlMissing, 'rules: []', 'yaml'));
    expect(error.message).toMatch(/needs the optional "yaml" package: run `npm install yaml`/);
    expect(error.cause).toMatchObject({ code: 'ERR_MODULE_NOT_FOUND' });
  });

  it('says to install yaml when loading a .yaml file', async () => {
    await expect(loadRulesWith(yamlMissing, fixture('rules.yaml'))).rejects.toThrow(
      /npm install yaml/,
    );
  });

  it('still loads JSON', async () => {
    await expect(loadRulesWith(yamlMissing, fixture('rules.json'))).resolves.toEqual(expected);
  });

  it('passes other import failures through unchanged', async () => {
    const broken = new Error('yaml exploded');
    const error = await rejection(
      parseRulesWith(() => Promise.reject(broken), 'rules: []', 'yaml'),
    );
    expect(error).toBe(broken);
  });
});
