# nemweb-proxy (Cloudflare Worker)

A thin edge-cached proxy between the NEMWEB tracker frontend and the
[OpenElectricity](https://platform.openelectricity.org.au) (OE) API.

**Why it exists**

- **Hides the OE API key.** The key lives in a Wrangler secret; the static
  frontend never sees it.
- **Shares data across visitors.** Responses are cached at Cloudflare's edge,
  so a busy day stays well under OE's free-tier **500 requests/day per key**
  regardless of how many tabs are open. Workers' own free tier is 100k
  req/day — not a concern.

## Endpoints

```
GET /demand?region={NSW1|VIC1|QLD1|SA1|TAS1|NEM}&from={ISO}&to={ISO}   # 5-min demand
GET /rooftop?region=...&from=...&to=...                                  # 30-min rooftop PV
```

Returns 5-minute operational demand for the range (rooftop is identical with
`"metric":"rooftop"`, `"interval":"30m"`). Rooftop note: OE's data endpoint has
no 30m interval, so the Worker requests `power` at 5m grouped by fueltech, picks
the `solar_rooftop` series, and downsamples to the `:00`/`:30` marks (the native
ASEFS2 readings — the 5m series is gap-filled between them).

```json
{
  "region": "NSW1",
  "metric": "demand",
  "interval": "5m",
  "unit": "MW",
  "points": [{ "ts": "2026-06-01T00:00:00+10:00", "value": 7123.4 }, ...]
}
```

- `region=NEM` fans out to the five regions and sums server-side, so the
  aggregate is a single shared cache entry.
- Cache TTL is 240s for `/demand` and 1500s for `/rooftop` (each just under its
  poll cycle), so an interval triggers at most one OE call no matter how many
  visitors.
- On an OE 5xx/timeout, the last cached response is served with an
  `X-Stale: true` header. On 401/403 (key problem) it returns `502` and logs —
  the OE key and upstream URL are never echoed in responses.
- `&debug=raw` (single region) returns the truncated raw upstream body for
  shape-checking, if OE's schema ever shifts. Both endpoints are verified
  against live OE.

## Deploy

Prerequisites: a Cloudflare account, an OE API key
(register at <https://platform.openelectricity.org.au>), and Node.

```bash
cd worker
npm install
npx wrangler login                 # one-time, opens browser
npx wrangler secret put OE_API_KEY # paste the OE key when prompted
npm run deploy
```

### Headless / remote machine (no browser)

`wrangler login` opens a browser via `xdg-open` and needs a localhost
callback, so it fails on a headless box (`Missing file or directory:
xdg-open`). Authenticate with an API token instead — no browser required:

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token →
   "Edit Cloudflare Workers"** (or a custom token with *Account → Workers
   Scripts → Edit*).
2. Export it and deploy:

```bash
export CLOUDFLARE_API_TOKEN=your_token_here   # do not commit
cd worker
npm install
npx wrangler whoami                # verifies the token
npx wrangler secret put OE_API_KEY # paste the OE key
npm run deploy
```


`deploy` prints the Worker URL, e.g.
`https://nemweb-proxy.<your-account>.workers.dev`.

### Verify

Both endpoints are verified against live OE. To re-check after a deploy (encode
the `+` in the offset as `%2B`):

```bash
# demand (known good)
curl "https://nemweb-proxy.<account>.workers.dev/demand?region=NSW1\
&from=2026-06-01T00:00:00%2B10:00&to=2026-06-01T00:30:00%2B10:00"

# rooftop — expect a non-empty points array during daylight
curl "https://nemweb-proxy.<account>.workers.dev/rooftop?region=NSW1\
&from=2026-06-01T00:00:00%2B10:00&to=2026-06-01T12:00:00%2B10:00"
```

If an endpoint returns an empty `points` array (or 502s) after an OE schema
change, inspect the upstream shape and adjust **only** that metric's
`url`/`parse` in `SPECS` (`src/index.ts`), then redeploy:

```bash
curl "https://nemweb-proxy.<account>.workers.dev/rooftop?region=NSW1\
&from=2026-06-01T00:00:00%2B10:00&to=2026-06-01T12:00:00%2B10:00&debug=raw"
```

The Worker URL is a build-time constant in the frontend
(`NEXT_PUBLIC_WORKER_URL`).

## CORS

Allowed origins are the GitHub Pages site and localhost (any port):

```
https://c-hat.github.io
http://localhost:*
```

No wildcard. Update `ALLOWED_ORIGIN` in `src/index.ts` if the deploy origin
changes.

## Local dev

```bash
npm run dev    # wrangler dev; needs OE_API_KEY in .dev.vars (gitignored)
npm run tail   # live-tail production logs
```

Create `worker/.dev.vars` (gitignored) with `OE_API_KEY=...` for local runs.
