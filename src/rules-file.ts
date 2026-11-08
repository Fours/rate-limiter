import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { InvalidRuleError, validateRules } from './rules.js';
import type { Rule } from './types.js';

/** The formats {@link parseRules} reads. */
export type RulesFormat = 'json' | 'yaml';

/** The part of the `yaml` package we use. */
interface YamlModule {
  parse(text: string): unknown;
}

export type YamlImporter = () => Promise<YamlModule>;

const importYaml: YamlImporter = () => import('yaml');

const FILE_FIELDS = ['rules'] as const;

/**
 * Every field a rule in a file may have. Typed against `Rule` so a field can't
 * be listed that `Rule` lacks; a type test catches the reverse (decision 0015).
 */
export const RULE_FIELDS = [
  'id',
  'limit',
  'windowMs',
  'burst',
  'algorithm',
  'method',
  'path',
  'tier',
] as const satisfies readonly (keyof Rule)[];

const FORMATS: Readonly<Record<string, RulesFormat>> = {
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
};

/**
 * Parses and validates a rules document, `{ rules: [...] }`. `source` names
 * where the text came from, such as a file path, and prefixes every error.
 * Throws InvalidRuleError; call it before `rateLimit()` so bad rules fail at startup.
 */
export function parseRules(text: string, format: RulesFormat, source?: string): Promise<Rule[]> {
  return parseRulesWith(importYaml, text, format, source);
}

/** Reads a rules file, taking the format from its `.json`, `.yaml` or `.yml` extension. */
export function loadRules(path: string): Promise<Rule[]> {
  return loadRulesWith(importYaml, path);
}

/** `loadRules` with the YAML import injected, so tests can simulate `yaml` being absent. */
export async function loadRulesWith(importer: YamlImporter, path: string): Promise<Rule[]> {
  const format = FORMATS[extname(path).toLowerCase()];
  if (format === undefined) {
    throw new InvalidRuleError(`${path}: rules files must end in .json, .yaml or .yml`);
  }
  // A missing file rejects here with ENOENT rather than meaning "no rules".
  const text = await readFile(path, 'utf8');
  return parseRulesWith(importer, text, format, path);
}

export async function parseRulesWith(
  importer: YamlImporter,
  text: string,
  format: RulesFormat,
  source?: string,
): Promise<Rule[]> {
  const prefix = source === undefined ? '' : `${source}: `;
  let parse: (text: string) => unknown = JSON.parse;
  if (format === 'yaml') {
    const yaml = await loadYaml(importer);
    parse = (yamlText) => yaml.parse(yamlText);
  }

  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new InvalidRuleError(`${prefix}not valid ${format.toUpperCase()}: ${reason}`, {
      cause: error,
    });
  }

  try {
    const rules = extractRules(document);
    validateRules(rules);
    return [...rules];
  } catch (error) {
    if (error instanceof InvalidRuleError && prefix !== '') {
      throw new InvalidRuleError(prefix + error.message, { cause: error });
    }
    throw error;
  }
}

async function loadYaml(importer: YamlImporter): Promise<YamlModule> {
  try {
    return await importer();
  } catch (error) {
    // Only rewrite "not installed"; anything else is a real fault worth seeing as is.
    if (isModuleNotFound(error)) {
      throw new Error(
        'Loading YAML rules needs the optional "yaml" package: run `npm install yaml`, or use a .json rules file.',
        { cause: error },
      );
    }
    throw error;
  }
}

function isModuleNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ERR_MODULE_NOT_FOUND'
  );
}

/** Checks the `{ rules: [...] }` wrapper and rejects unknown fields, which validateRules allows. */
function extractRules(document: unknown): unknown[] {
  if (!isPlainObject(document) || !('rules' in document)) {
    throw new InvalidRuleError('must be an object with a "rules" list, like { "rules": [] }');
  }
  rejectUnknown(document, FILE_FIELDS, 'top level');

  const { rules } = document;
  if (!Array.isArray(rules)) throw new InvalidRuleError('"rules" must be a list');
  rules.forEach((rule: unknown, index) => {
    if (!isPlainObject(rule)) return; // validateRules reports the wrong type with its position
    const position = `rules[${String(index)}]`;
    const label =
      typeof rule.id === 'string' ? `${position} (${JSON.stringify(rule.id)})` : position;
    rejectUnknown(rule, RULE_FIELDS, label);
  });
  return rules;
}

function rejectUnknown(
  object: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(object).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new InvalidRuleError(
      `${label}: unknown field ${JSON.stringify(unknown)}; allowed fields are ${allowed.join(', ')}`,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
