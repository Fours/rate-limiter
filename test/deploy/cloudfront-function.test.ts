import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Field {
  value: string;
  multiValue?: { value: string }[];
}

interface Request {
  method: string;
  uri: string;
  querystring: Record<string, Field>;
  headers: Record<string, Field>;
  cookies: Record<string, Field>;
}

interface Response {
  statusCode: number;
  statusDescription?: string;
  headers: Record<string, Field>;
}

type Handler = (event: { request: Request }) => Request | Response;

// CloudFront runs the file as a plain script and calls `handler` by name, with no module
// system, so load it the same way rather than importing it.
const source = readFileSync(
  new URL('../../deploy/cloudfront-function.js', import.meta.url),
  'utf8',
);
// eslint-disable-next-line @typescript-eslint/no-implied-eval -- our own file, loaded as CloudFront loads it
const load = new Function(`${source}\nreturn handler;`) as () => Handler;
const handler = load();

function request(uri: string, querystring: Record<string, Field> = {}): Request {
  return { method: 'GET', uri, querystring, headers: {}, cookies: {} };
}

function run(uri: string, querystring?: Record<string, Field>): Request | Response {
  return handler({ request: request(uri, querystring) });
}

function isResponse(result: Request | Response): result is Response {
  return 'statusCode' in result;
}

describe('the CloudFront Function', () => {
  it.each([
    ['/', '/index.html'],
    ['/how-it-works/', '/how-it-works/index.html'],
  ])('serves %s from its folder’s index.html', (uri, expected) => {
    const result = run(uri);
    expect(isResponse(result)).toBe(false);
    expect((result as Request).uri).toBe(expected);
  });

  it('redirects a folder without its trailing slash, permanently', () => {
    const result = run('/how-it-works');
    expect(result).toMatchObject({
      statusCode: 301,
      headers: { location: { value: '/how-it-works/' } },
    });
  });

  it('keeps the query string on the redirect, repeated keys and empty values included', () => {
    const result = run('/how-it-works', {
      utm_source: { value: 'portfolio' },
      tag: { value: 'a', multiValue: [{ value: 'a' }, { value: 'b%20c' }] },
      flag: { value: '' },
    });
    expect(result).toMatchObject({
      statusCode: 301,
      headers: { location: { value: '/how-it-works/?utm_source=portfolio&tag=a&tag=b%20c&flag' } },
    });
  });

  it.each([
    '/assets/demo-DDaqAgOz.js',
    '/assets/glue-Dlydm7r2.wasm',
    '/index.html',
    '/how-it-works/index.html',
  ])('passes %s through unchanged', (uri) => {
    const original = request(uri);
    const result = handler({ request: { ...original } });
    expect(result).toEqual(original);
  });

  // Node runs syntax CloudFront's runtime (cloudfront-js-2.0) rejects, so these tests can pass on
  // a file the console won't run. `for...of` is the one that has bitten: "Token "of" not
  // supported", found by testing the function in the console.
  it('uses no for...of, which CloudFront’s runtime rejects', () => {
    expect(source).not.toMatch(/\bfor\s*\([^)]*\bof\b/);
  });
});
