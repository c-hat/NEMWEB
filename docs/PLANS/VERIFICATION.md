# Verification Playbook & Cutover Note

How to know each workstream works — and that they work together — while migrating
from the static GitHub Pages app to the Cloudflare architecture, working through
the workstreams **sequentially in one terminal** (no orchestrator agent).

## 1. How verification changed

On GitHub Pages there was **one** proof-of-correctness loop: commit to `main` →
Actions builds → the live site shows the change, end to end. That worked because
data and frontend shipped together in one static deploy — the site *was* the
proof.

The target architecture ([`../ARCHITECTURE.md`](../ARCHITECTURE.md)) deliberately
splits that loop into layers — ingest → storage (R2/D1) → Worker API → frontend
— so the data no longer travels with the page. There is no longer a single URL
that proves the whole system. Instead:

- **Each layer is verified on its own**, and
- **the layers are verified to agree** with each other.

Two facts make this tractable:

1. **The old path stays alive as the reference.** `public/data/` (committed) and
   GitHub Pages are not torn down until the new path provably matches them. The
   "is it working?" oracle is always available — it's the thing being migrated
   away from, kept running on purpose.
2. **Byte-compatibility is the universal oracle.** Almost every gate below is
   "new output diffs clean against the known-good old output." A clean diff is
   correctness; you rarely have to reason about correctness in the abstract.

**Reference day:** `2026-05-28` — the day validated end-to-end against live
NEMWEB in [`../../FLAGS.md`](../../FLAGS.md). Use it everywhere a single concrete
day is needed.

Each gate is tagged **[now]** (runnable against today's repo) or **[later]**
(needs a layer that doesn't exist yet) so a check that can't run yet is never
mistaken for a failure.

## 2. Per-workstream verification gates

### Ingest (02)

- ☐ **[now]** Ingest tests pass (`ingest/` + `tests/` suite).
- ☐ **[now]** Re-ingesting the reference day reproduces the committed
  `public/data/2026-05-28.json` with **no diff**.
- ☐ **[now]** `index.json` / `latest.json` regenerate unchanged.
- ☐ **[later]** Once the normalized-dataset refactor lands: the compatibility
  per-day projection is **byte-identical** to current output for the reference
  day.
- ☐ **[later]** A second source adapter can be added without editing NEMWEB code
  (proves the adapter seam).

### Analysis (05)

- ☐ **[now]** Analysis tests pass.
- ☐ **[now]** Regenerated `demand-error-rankings.json` diffs **clean** against
  the committed file.
- ☐ **[later]** Each analysis emits a descriptor **and** a versioned payload
  (`id, type, version, inputs, parameters, generatedAt, data`).
- ☐ **[later]** Adding an analysis requires no change to ingest adapters or chart
  code.

### Storage & Catalog (03)

- ☐ **[later]** D1 migrations apply cleanly from a clean database.
- ☐ **[later]** **Seed-then-read round-trip:** an object written to R2, then read
  back, diffs **clean** against its source file (`compat/day/2026-05-28.json`
  equals `public/data/2026-05-28.json`).
- ☐ **[later]** The storage module is the **only** code that references R2 keys
  or D1 SQL (grep confirms nothing else does).
- ☐ **[later]** Catalog generator output lists the expected datasets/analyses.

### Worker API (04)

- ☐ **[later]** `wrangler dev` serves locally.
- ☐ **[later]** Each compat endpoint diffs **clean** against the matching static
  file for the reference day:
  - `GET /api/days` ≡ `public/data/index.json`
  - `GET /api/latest` ≡ `public/data/latest.json`
  - `GET /api/day/2026-05-28` ≡ `public/data/2026-05-28.json`
  - `GET /api/live` ≡ current live file shape
- ☐ **[later]** `GET /api/catalog`, `/api/analyses`, `/api/analyses/:id` return
  the documented shapes ([`../DATA_CONTRACTS.md`](../DATA_CONTRACTS.md)).
- ☐ **[now]** Cron dispatcher behaviour is unchanged — Worker tests cover
  `scheduled`, and a manual `live-data` dispatch still fires. (Guard this on
  every Worker change, since the API work shares `worker/`.)
- ☐ **[later]** CORS allows the Pages origin; error bodies are consistent JSON.

### Frontend (01)

- ☐ **[now]** `npm run build` (static export) succeeds with no errors.
- ☐ **[now]** Data-layer + chart smoke tests pass (once added).
- ☐ **[now/later]** **Cross-source parity (the key gate):** the same chart for
  the reference day renders **identically** with `NEXT_PUBLIC_DATA_SOURCE=static`
  vs `=api`. The toggle exists today in `lib/dataSource.ts`; the `api` side uses
  `lib/api.ts`. Runnable now structurally — it only fetches successfully once the
  Worker serves the endpoints, so this gate *completes* when Worker API (04)
  lands.
- ☐ **[later]** Live overlay works via `GET /api/live`, with the
  `raw.githubusercontent.com` fallback still selectable behind the flag.

### CI & Deployment (06)

- ☐ **[later]** CI runs the full matrix: Python (ingest/analysis), JS (frontend),
  Worker tests — all gate PRs.
- ☐ **[later]** **Parallel-deploy parity:** the Cloudflare Pages URL serves
  **identically** to the GitHub Pages URL while both run.
- ☐ **[later]** R2/D1 are provisioned, bound in `wrangler.toml`, and migrated
  from CI; the seed reproduces current data.
- ☐ **[later]** A documented rollback exists at each cutover (see §4).

## 3. Integration checks ("do they all work together?")

Run these **after the Worker API exists**, and **again after the frontend default
flips to `api`**. Reference day `2026-05-28`.

### 3a. Bottom-up byte-compat chain

- ☐ Ingest file `public/data/2026-05-28.json`
- ☐ == R2 object `compat/day/2026-05-28.json` (seed-then-read)
- ☐ == `GET /api/day/2026-05-28` response

All three identical ⇒ the data layers agree from disk to API.

### 3b. Top-down visual parity

- ☐ Frontend with `NEXT_PUBLIC_DATA_SOURCE=static` — note the chart for the
  reference day.
- ☐ Same frontend with `=api` (pointed at the Worker via
  `NEXT_PUBLIC_API_BASE_URL`) — chart is **visually identical**.

3a + 3b green ⇒ the stack agrees end to end. Because each layer was already
verified against the old known-good output on the way in, "they all work
together" reduces to "each layer matches the reference, and the reference still
works."

## 4. Cutover note (sequencing discipline)

The order in which layers go green before each **irreversible** step. This is the
only "orchestrator" residue — an ordering, not a running agent. Each step names
its rollback.

1. **Flip frontend default to `api`** — only after Worker compat endpoints pass
   §2 (Worker) byte-compat **and** §3b cross-source parity.
   *Rollback:* set `NEXT_PUBLIC_DATA_SOURCE=static` and rebuild.
2. **Retire the `live-data` branch / `raw.githubusercontent.com` path** — only
   after `GET /api/live` passes its gate in production.
   *Rollback:* re-point `NEXT_PUBLIC_LIVE_DATA_URL` at the raw URL; the orphan
   branch + `live-data.yml` still exist.
3. **Move `public/data` writes out of git into R2** — only after the Worker
   serves storage-backed data **and** a production release has run clean on
   `api`.
   *Rollback:* re-enable the `ingest.yml` commit step; `public/data` is still in
   git history.
4. **Decommission GitHub Pages** — only after Cloudflare Pages + Worker API have
   served a production release with **no regression** vs the parallel GitHub
   Pages URL (§2 CI parallel-deploy parity).
   *Rollback:* re-enable `deploy-pages.yml`; keep both deploys until confident.

Never take a step before its predecessor is green. Run old and new paths in
parallel across each cutover.
