# NEMWEB

Tracking NEM data: a static frontend that visualises AEMO half-hourly demand
and rooftop PV forecasts (POE bands) against actuals.

## Frontend

A [Next.js](https://nextjs.org) app (static export) rooted at the repo root,
using TypeScript, React and [Recharts](https://recharts.org). The committed
data in `public/data/` is served as-is and fetched at runtime, so newly
ingested days appear without rebuilding the app.

### Local development

```bash
npm install
npm run dev      # http://localhost:3000
```

### Production build

```bash
npm run build    # static export to out/ (gitignored)
```

The export is fully static — `output: 'export'` in `next.config.js` writes
`out/`, and the data files under `public/data/` are copied into `out/data/`.

### Data loading

At runtime the app fetches from the data directory:

- `data/index.json` — available days, ascending (`[{ "date": ... }]`)
- `data/latest.json` — pointer to the most recent day (`{ "date", "path" }`)
- `data/<date>.json` — per-day forecast/actual payload (48 half-hour intervals)
- `data/today.json` — the in-progress trading day's forecast plume, actuals
  empty (optional; present once the ingest has run with `--today`)

Fetch paths are prefixed with `NEXT_PUBLIC_BASE_PATH` so the app works when
deployed under a repository subpath (see below). The ingest pipeline in
`ingest/` owns `public/data/` and is independent of the frontend.

### Live "today" overlay

When `today.json` exists and today (AEST) is selected, the demand chart overlays
**live 5-minute actuals** on the forecast plume, polled through the Cloudflare
Worker proxy in `worker/` (which fronts the OpenElectricity API). The chart
shows a LIVE badge; polling pauses when the tab is hidden and resumes on focus.
Past days are unaffected and never poll.

Caveats:

1. **Demand definition mismatch.** The Worker serves OpenElectricity's
   `DISPATCHREGIONSUM.TOTALDEMAND` (dispatch-process demand). The forecast
   plumes are calibrated to `DEMANDOPERATIONALACTUAL`, defined slightly
   differently — so the live line sits close to, but not exactly on, the
   half-hourly operational actuals.
2. **Third-party dependency.** The live view depends on the OpenElectricity API
   via the Worker. If OE is unavailable the view degrades to a STALE state
   (last-known data); the historical view is unaffected.

Rooftop PV live actuals (native 30-minute cadence) are a planned follow-up.
The Worker URL is a build-time constant (`NEXT_PUBLIC_WORKER_URL`, defaulting to
the deployed proxy); see `worker/README.md`.

### Deployment (GitHub Pages)

`.github/workflows/deploy-pages.yml` builds and deploys `out/` to GitHub Pages
on every push to `main` (and on manual dispatch). Project Pages serve under
`/<repo>`, so the workflow sets:

```
NEXT_PUBLIC_BASE_PATH=/${{ github.event.repository.name }}
```

which prefixes both the static assets and the runtime data fetches. To deploy,
enable Pages with **Settings → Pages → Source: GitHub Actions**.

For a root deployment (custom domain or user/org Pages), leave
`NEXT_PUBLIC_BASE_PATH` unset and the app uses root-relative paths.
