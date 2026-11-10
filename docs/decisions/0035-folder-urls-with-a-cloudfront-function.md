# 0035. The demo site serves folder URLs with a CloudFront Function

- **Status:** Accepted
- **Date:** 2026-11-10
- **Milestone:** 5

## Context

The demo site has two pages: the demo at `/` and the write-up at `/how-it-works/`, a second HTML entry so it has a URL worth sharing (spec T7). It's hosted the portfolio's way: a private bucket (`kylewillett.com`, prefix `rate-limiter/`) read by CloudFront through Origin Access Control (OAC). CloudFront asks S3's REST API for the exact key it's given, and its default root object applies only to `/`. So `/how-it-works/` asks S3 for the key `rate-limiter/how-it-works/`, which doesn't exist, and a private bucket answers 403. The portfolio never hit this, because it's one page.

## Decision

- **A CloudFront Function on viewer request** ([deploy/cloudfront-function.js](../../deploy/cloudfront-function.js)), on the distribution's default behaviour:
  - a path ending in `/` is served from that folder's `index.html`, so `/how-it-works/` reads `how-it-works/index.html`;
  - a path whose last segment has no `.` is redirected, `301`, to the same path with a `/`, keeping the query string;
  - anything else, such as `/assets/demo-abc123.js`, passes through untouched.
- **The redirect, rather than serving `/how-it-works` too,** gives each page one URL, so PostHog counts one path per page and links shared either way end up the same. It also keeps the pages' relative links right: they resolve from inside the folder.
- **The function is in the repo and tested.** `test/deploy/cloudfront-function.test.ts` loads the file the way CloudFront does, as a plain script calling `handler` by name, and checks each case. The console holds a copy; [DEPLOY.md](../../DEPLOY.md) says how to update it.

## Alternatives considered

| Option | Why not |
| --- | --- |
| The S3 website endpoint as the origin | It serves `index.html` for folders on its own, but only from a public bucket, over HTTP, and without OAC. The bucket holds every site and stays private. |
| Flat pages: `how-it-works.html` | Works with no function, but the URL carries `.html`, or needs the same kind of function to drop it. |
| Lambda@Edge | Does the same, at more cost and latency, and deploys from `us-east-1` with its own IAM role. A CloudFront Function is enough for rewriting a path. |
| Rewrite every extensionless path to `<path>/index.html`, no redirect (AWS's sample) | Two URLs for each page, and a relative link on a page reached without its slash would resolve from the wrong folder. |
| A 403 custom error page that serves `index.html` | A single-page-app pattern: every missing file would get the demo, with a 200, instead of a 404. |
| One page, with the write-up as `#how-it-works` | Decided against in T7: the write-up needs its own URL, title and link preview, and mustn't load wasmoon. |

## Evidence

The unit test covers each case: `/` and `/how-it-works/` rewritten, `/how-it-works` redirected with its query string (repeated keys and empty values included), and four asset and page paths passed through. Breaking the function five ways, each on its own, failed it each time: no `index.html` rewrite, a `302` instead of a `301`, redirecting files too, dropping the query string, and dropping repeated keys.

Testing the function in the CloudFront console found what Node couldn't: the runtime (cloudfront-js-2.0) rejected the first version with `SyntaxError: Token "of" not supported`, from a `for...of` loop. The loops are index loops now, and the test fails on `for...of` in the source.

**Live**, after the first `npm run deploy` on 2026-11-10, with `curl -sI` against https://rate-limiter.kylewillett.com:

| Path | Status | What came back |
| --- | --- | --- |
| `/` | 200 | `text/html`, `Cache-Control: no-cache` |
| `/how-it-works/` | 200 | `text/html`, `no-cache`: the write-up's title |
| `/how-it-works?utm_source=x&tag=a&tag=b%20c` | 301 | `Location: /how-it-works/?utm_source=x&tag=a&tag=b%20c`, `X-Cache: FunctionGeneratedResponse` |
| `/index.html` | 200 | passed through |
| `/assets/glue-Dlydm7r2.wasm` | 200 | `application/wasm`, `public, max-age=31536000, immutable` |

The query string went back out exactly as it came in, `%20` included, so CloudFront gives the function values as they arrived, not decoded. Then all 16 Playwright tests passed against the live site, with `E2E_BASE_URL=https://rate-limiter.kylewillett.com npx playwright test`, including the dashboard's link to the write-up and the write-up's links back, and no request leaving the site.

## Consequences

- A new page in the site is a new folder with an `index.html`, and needs nothing in CloudFront.
- A path with a `.` in its last segment is never redirected, so a page can't be named like a file.
- The function isn't deployed by `npm run deploy`. A change to it is pasted into the console and published, by hand, like the distribution's other settings. That's rare, and keeping the deployer out of CloudFront's function APIs keeps its policy small.
- Query strings go back out as CloudFront gave them to the function.
