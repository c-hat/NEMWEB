# Cloudflare Setup Checklist

This guide covers the manual actions required to provision the Cloudflare
runtime for the NEMWEB migration:

- R2 stores generated JSON payloads and future normalized/source payloads.
- D1 stores catalog metadata, source runs, dataset availability, and analysis
  indexes.
- The Worker exposes the browser API boundary.
- Cloudflare Pages hosts the static Next.js export.

The current app can remain on static `public/data` while these resources are
created. The Worker API has GitHub raw-data fallback behavior, so R2/D1 can be
introduced without immediately changing the frontend runtime source.

## Provisioned Environment

These Cloudflare resources have been created in the
`Caseychatterton@gmail.com's Account` account:

```text
Account ID: 2e0dbfa31a9a6844a264cd86d0d8d63c
R2 bucket: nemweb-data-prod
D1 database: nemweb-catalog-prod
D1 database ID: cb7b05b5-64fb-4fad-94dc-f0566f480a36
Worker: nemweb-live-pinger
Worker URL: https://nemweb-live-pinger.nemwebber.workers.dev
Pages project: nemweb
Pages production URL: https://nemweb.pages.dev
```

The Worker is configured with:

```text
NEMWEB_BUCKET -> nemweb-data-prod
NEMWEB_DB -> nemweb-catalog-prod
DATA_FALLBACK_BASE_URL -> https://raw.githubusercontent.com/c-hat/NEMWEB/main/public
LIVE_DATA_URL -> https://raw.githubusercontent.com/c-hat/NEMWEB/live-data/today-live.json
ALLOWED_ORIGIN -> https://nemweb.pages.dev
```

The D1 migration `0001_storage_catalog.sql` has been applied remotely.

The Worker secret `GH_DISPATCH_TOKEN` is present on the deployed Worker.

GitHub Actions configuration is present on `c-hat/NEMWEB`:

```text
Repository secret: CLOUDFLARE_API_TOKEN
Repository variable: CLOUDFLARE_ACCOUNT_ID=2e0dbfa31a9a6844a264cd86d0d8d63c
Repository variable: CLOUDFLARE_PAGES_PROJECT=nemweb
Repository variable: NEMWEB_D1_DATABASE_NAME=nemweb-catalog-prod
Repository variable: NEMWEB_R2_BUCKET=nemweb-data-prod
Repository variable: NEMWEB_API_BASE_URL=https://nemweb-live-pinger.nemwebber.workers.dev
```

## 1. Local Prerequisites

From the repo root:

```sh
cd worker
npm ci
npx wrangler login
npx wrangler whoami
```

Confirm `wrangler whoami` shows the Cloudflare account you want to deploy into.

## 2. Create The R2 Bucket

Create a production bucket for NEMWEB data:

```sh
cd worker
npx wrangler r2 bucket create nemweb-data-prod --location oc
```

Recommended bucket name:

```text
nemweb-data-prod
```

Recommended location:

```text
oc
```

The `oc` jurisdiction keeps the bucket in Oceania. If the account does not
support that location, use Cloudflare's default location and keep the bucket name
the same.

The planned R2 object layout is documented in
`docs/DECISIONS/0002-storage-layout.md`. The compatibility objects currently
expected by the Worker are:

```text
compat/index.json
compat/latest.json
compat/live.json
compat/day/<YYYY-MM-DD>.json
```

## 3. Create The D1 Database

Create the catalog database:

```sh
cd worker
npx wrangler d1 create nemweb-catalog-prod --location oc
```

Copy the `database_id` from Wrangler's output. You will paste it into
`worker/wrangler.toml`.

Recommended database name:

```text
nemweb-catalog-prod
```

## 4. Configure Worker Bindings

Edit `worker/wrangler.toml` and add the real R2 and D1 bindings.

```toml
[[r2_buckets]]
binding = "NEMWEB_BUCKET"
bucket_name = "nemweb-data-prod"

[[d1_databases]]
binding = "NEMWEB_DB"
database_name = "nemweb-catalog-prod"
database_id = "cb7b05b5-64fb-4fad-94dc-f0566f480a36"
migrations_dir = "migrations"

[vars]
DATA_FALLBACK_BASE_URL = "https://raw.githubusercontent.com/c-hat/NEMWEB/main/public"
LIVE_DATA_URL = "https://raw.githubusercontent.com/c-hat/NEMWEB/live-data/today-live.json"
ALLOWED_ORIGIN = "https://nemweb.pages.dev"

[observability.logs]
enabled = true
```

If a custom production domain is configured for Pages, use that final public
origin instead.

## 5. Apply D1 Migrations

Apply the schema in `worker/migrations/0001_storage_catalog.sql`:

```sh
cd worker
npx wrangler d1 migrations apply nemweb-catalog-prod --remote
```

Verify that tables exist:

```sh
npx wrangler d1 execute nemweb-catalog-prod --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```

Expected core tables include:

```text
sources
source_runs
datasets
dataset_availability
analyses
analysis_availability
data_quality
schema_versions
```

## 6. Configure Worker Secrets

The existing scheduled Worker dispatches GitHub workflows. Confirm the GitHub
dispatch token is present:

```sh
cd worker
npx wrangler secret list
```

If `GH_DISPATCH_TOKEN` is missing, set it:

```sh
cd worker
npx wrangler secret put GH_DISPATCH_TOKEN
```

Paste a GitHub token with permission to dispatch the target workflow in this
repo.

No Cloudflare API token is needed inside the Worker runtime. Cloudflare API
tokens are used by GitHub Actions for deployment.

## 7. Deploy The Worker

Run typecheck and deploy:

```sh
cd worker
npm run typecheck
npx wrangler deploy
```

After deploy, note the Worker URL. It will look similar to:

```text
https://nemweb-worker.<account-subdomain>.workers.dev
```

## 8. Smoke Test The Worker

Use the deployed Worker URL:

```sh
curl -i https://<WORKER_URL>/
curl -i https://<WORKER_URL>/api/days
curl -i https://<WORKER_URL>/api/latest
curl -i https://<WORKER_URL>/api/catalog
curl -i https://<WORKER_URL>/api/live
```

Expected results during the transitional state:

- `/` returns health text.
- `/api/days` returns the compatibility index, falling back to GitHub raw data
  if R2 is empty.
- `/api/latest` returns the latest compatibility day payload, falling back to
  GitHub raw data if R2 is empty.
- `/api/live` returns live data, falling back to the `live-data` branch if R2 is
  empty.
- `/api/catalog` returns D1 catalog data when the D1 binding exists. It may be
  empty until seeding is implemented.

## 9. Create The Cloudflare Pages Project

From the repo root:

```sh
npx wrangler pages project create nemweb --production-branch main
```

Recommended Pages project name:

```text
nemweb
```

Build and deploy the current static frontend:

```sh
npm ci
NEXT_PUBLIC_DATA_SOURCE=static npm run build
npx wrangler pages deploy out --project-name nemweb --branch main
```

Keep `NEXT_PUBLIC_DATA_SOURCE=static` until R2/D1 seeding and the Worker API
cutover are ready. This preserves the current app behavior while hosting moves
to Cloudflare Pages.

## 10. Configure GitHub Actions

Add this repository secret:

```text
CLOUDFLARE_API_TOKEN
```

The token needs permission to deploy Workers, deploy Pages, and apply D1
migrations for this account.

Add these repository variables:

```text
CLOUDFLARE_PAGES_PROJECT=nemweb
NEMWEB_D1_DATABASE_NAME=nemweb-catalog-prod
```

If GitHub Actions cannot infer the Cloudflare account, also add:

```text
CLOUDFLARE_ACCOUNT_ID=<your-account-id>
```

The relevant workflows are:

- `.github/workflows/test.yml`
- `.github/workflows/deploy-worker.yml`
- `.github/workflows/deploy-cloudflare-pages.yml`

## 11. Verify CI And Deployments

After pushing the configuration changes:

1. Confirm `.github/workflows/test.yml` passes.
2. Run or wait for `.github/workflows/deploy-worker.yml`.
3. Run or wait for `.github/workflows/deploy-cloudflare-pages.yml`.
4. Smoke test the Worker endpoints again.
5. Open the Pages URL and confirm the frontend loads data.

Current smoke test status:

```text
Worker / -> 200 text/plain
Worker /api/days -> 200 application/json, 389 entries
Worker /api/latest -> 200 application/json, keys: date, path
Worker /api/catalog -> 200 application/json, 0 datasets, 0 analyses
Pages / -> 200 text/html
```

Post-publish smoke test status:

```text
Worker /api/days -> 200 application/json, 389 historical days, last day 2026-06-04
Worker /api/latest -> 200 application/json, date 2026-06-04
Worker /api/day/2026-06-05 -> 200 application/json, tradingDate 2026-06-05
Worker /api/catalog -> 200 application/json, 4 datasets, 1 analysis
Worker /api/analyses/demand-forecast-error-ranking -> 200 application/json
Worker /api/analyses/demand-error-ranking -> 200 application/json legacy alias
Pages / -> 200 text/html
```

GitHub repository variables can be verified with:

```sh
gh variable list --repo c-hat/NEMWEB
```

GitHub repository secret names can be verified with:

```sh
gh secret list --repo c-hat/NEMWEB
```

## 12. Remaining Cutover Work

The seed/publish path is implemented in `scripts/publish_cloudflare.py`.

Historical/static publish:

```sh
python3 scripts/publish_cloudflare.py \
  --bucket nemweb-data-prod \
  --database nemweb-catalog-prod
```

If the deploy token can write R2 but cannot write D1 yet, publish R2
compatibility objects without catalog writes:

```sh
python3 scripts/publish_cloudflare.py \
  --bucket nemweb-data-prod \
  --skip-d1
```

Live-data publish:

```sh
python3 scripts/publish_cloudflare.py \
  --only-live \
  --live today-live.json \
  --bucket nemweb-data-prod
```

The historical publisher:

1. Uploads generated day payloads to R2 under `compat/day/<date>.json`.
2. Uploads `public/data/today.json` to both `compat/today.json` and
   `compat/day/<today tradingDate>.json`.
3. Uploads `compat/index.json` and `compat/latest.json` last, after day payloads.
4. Uploads demand forecast-error rankings to both compatibility and versioned
   analysis R2 keys.
5. Inserts or updates D1 catalog rows for source metadata, source runs, dataset
   families, dataset availability, analysis descriptors, and analysis
   availability.

The scheduled `ingest` workflow publishes historical/static data after
generating `public/data`. The `live-data` workflow publishes `today-live.json`
to `compat/live.json` after each live refresh.

D1 catalog publishing from CI is gated behind:

```text
NEMWEB_PUBLISH_D1=true
```

Leave it unset until `CLOUDFLARE_API_TOKEN` has D1 query/write permission.
R2 compatibility publishing still runs without it.

Cloudflare Pages now builds in API mode:

```sh
NEXT_PUBLIC_DATA_SOURCE=api \
NEXT_PUBLIC_API_BASE_URL=https://nemweb-live-pinger.nemwebber.workers.dev \
npm run build
```

The Cloudflare Pages workflow uses `NEMWEB_API_BASE_URL` for
`NEXT_PUBLIC_API_BASE_URL`. `ALLOWED_ORIGIN` is already tightened to the
production Pages origin.

## 13. Pending Product Decision

The ingest currently preserves the existing day-ahead reference behavior:

```text
D-1 17:00 AEST stamped run
```

Before changing ingest output semantics, decide whether to keep that behavior or
switch to:

```text
D-1 16:00 AEST stamped run
```

Keep this decision separate from the Cloudflare infrastructure setup so the app
can migrate runtime platforms without changing forecast semantics at the same
time.
