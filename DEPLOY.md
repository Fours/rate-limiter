# Deploying the demo site

The demo site (`demo/`: the live demo and the write-up at `how-it-works/`) is a static build, `demo/dist/`, hosted on **S3 behind CloudFront**, the same way as the portfolio. This is the site only. The npm package is published from CI on a version tag ([0025](docs/decisions/0025-publish-from-ci-with-provenance.md)).

- **Site:** https://rate-limiter.kylewillett.com/
- **Bucket:** `kylewillett.com`, objects under the `rate-limiter/` prefix (`s3://kylewillett.com/rate-limiter/`)
- **Region:** `us-east-1`
- **Served at a subdomain root.** CloudFront's **Origin Path** is `/rate-limiter`, so the site sees itself at `/`. That's why Vite's `base` stays the default `/` and the app needs no path rewriting.
- The bucket stays **private**. CloudFront reads it through an **Origin Access Control (OAC)**.
- **A CloudFront Function serves folder URLs** ([deploy/cloudfront-function.js](deploy/cloudfront-function.js), [0035](docs/decisions/0035-folder-urls-with-a-cloudfront-function.md)). S3 behind OAC serves exact keys only, and the default root object covers just `/`, so without it `/how-it-works/` is a 403.

## One-time setup

1. **Install and configure the AWS CLI** with the shared deployer's credentials (one IAM user deploys every site in the bucket):
   ```bash
   aws configure
   ```
   See [IAM permissions](#iam-permissions).

2. **Create the CloudFront Function.** CloudFront → Functions → Create function: name `rate-limiter-folder-index`, runtime **cloudfront-js-2.0**. Paste [deploy/cloudfront-function.js](deploy/cloudfront-function.js), save, then **Publish**.

3. **Create the distribution.**
   - Origin: the `kylewillett.com` bucket's S3 (REST) endpoint, not the website endpoint, with **Origin Access Control**. Origin path: `/rate-limiter`.
   - Default cache behaviour: redirect HTTP to HTTPS, the `CachingOptimized` policy, and under **Function associations**, *Viewer request* → CloudFront Functions → `rate-limiter-folder-index`.
   - Alternate domain name: `rate-limiter.kylewillett.com`, with the existing `*.kylewillett.com` ACM certificate.
   - Default root object: `index.html`.
   - Then add the statement CloudFront offers to the **bucket policy**, so this distribution can read objects. Add it beside the other sites' statements rather than replacing them.

4. **DNS.** In Route 53, an `A` (and `AAAA`) alias record for `rate-limiter.kylewillett.com` pointing at the distribution.

5. **Let the deployer invalidate it.** Add the distribution's ARN to the shared deployer's `InvalidateCloudFront` statement (see [IAM permissions](#iam-permissions)).

6. **Give the deploy script the distribution ID.** The real file is gitignored, so the ID never gets committed:
   ```bash
   cp scripts/deploy.config.local.example scripts/deploy.config.local
   # edit scripts/deploy.config.local and set CLOUDFRONT_DISTRIBUTION_ID
   ```
   Or export `CLOUDFRONT_DISTRIBUTION_ID` in your shell instead.

7. **PostHog's key.** The demo reads it from `demo/.env.local`, which is gitignored too:
   ```bash
   cp demo/.env.example demo/.env.local
   # edit demo/.env.local and set the key
   ```
   The deploy script refuses to run without it, since the site would build and work but never count a visit.

## Deploy

```bash
npm run deploy
```

That runs [`scripts/deploy.sh`](scripts/deploy.sh), which:

1. **Builds** the site (`npm run demo:build` → `demo/dist/`).
2. **Syncs assets** to `s3://kylewillett.com/rate-limiter/` with a 1-year immutable cache. Their names are content-hashed (the scripts, styles, fonts and wasmoon's `.wasm`), so they can be cached forever. `--delete` prunes old bundles.
3. **Uploads the HTML pages**, `index.html` and `how-it-works/index.html`, with `Cache-Control: no-cache`, so a new deploy is picked up immediately. They're the only files whose names never change.
4. **Invalidates CloudFront** (`/*`) so edge caches serve the new pages.

## Changing the CloudFront Function

`npm run deploy` doesn't touch it. After changing [deploy/cloudfront-function.js](deploy/cloudfront-function.js) and its test (`test/deploy/cloudfront-function.test.ts`), paste it into the function in the console, test it there with a viewer request for `/how-it-works`, and **Publish**. The distribution uses the published version.

## Config overrides

The script reads these from the environment or `scripts/deploy.config.local`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLOUDFRONT_DISTRIBUTION_ID` | *(required)* | Distribution to invalidate |
| `DEPLOY_BUCKET` | `kylewillett.com` | Target bucket |
| `DEPLOY_PREFIX` | `rate-limiter` | Key prefix within the bucket |
| `DEPLOY_REGION` | `us-east-1` | Bucket region |

## IAM permissions

All sites in the `kylewillett.com` bucket (portfolio, quiz, solar-system, archery-blitz, rate-limiter, …) deploy with **one shared deployer IAM user**. Its policy is in [`deploy/iam-policy.json`](deploy/iam-policy.json) and grants exactly what the deploy scripts call:

- `s3:ListBucket` on `kylewillett.com` (so `s3 sync` can diff)
- `s3:PutObject` / `s3:DeleteObject` on the **whole bucket** (`kylewillett.com/*`). This is intentional, because the same user deploys every site's prefix.
- `cloudfront:CreateInvalidation` on each site's distribution

**Adding this site:** don't create a new user. Add this distribution's ARN (`arn:aws:cloudfront::ACCOUNT_ID:distribution/<DIST_ID>`) to the `Resource` list of the deployer's `InvalidateCloudFront` statement. If you skip it, the S3 sync succeeds but the invalidation fails with AccessDenied.

If `s3 sync` ever reports a permission error, add `s3:GetObject` on `arn:aws:s3:::kylewillett.com/*`. Some sync comparisons use it.

Don't deploy with your root account or an admin identity. Keep the deployer scoped to this bucket and these distributions, and rotate its access key periodically.

## Notes

- **A new page** is a new folder in `demo/` with an `index.html`, added to `rolldownOptions.input` in `demo/vite.config.ts`. The function serves it with no change in CloudFront.
- **If the site is ever served under a URL path** (e.g. `kylewillett.com/rate-limiter/` instead of a subdomain root), set `base: '/rate-limiter/'` in `demo/vite.config.ts` and rebuild, or the hashed assets will 404.
