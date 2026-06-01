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

## Endpoint (current phase)

```
GET /demand?region={NSW1|VIC1|QLD1|SA1|TAS1|NEM}&from={ISO}&to={ISO}
```

Returns 5-minute operational demand for the range:

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
- Cache TTL is 240s (just under the frontend's 5-min poll), so each interval
  triggers at most one OE call no matter how many visitors.
- On an OE 5xx/timeout, the last cached response is served with an
  `X-Stale: true` header. On 401/403 (key problem) it returns `502` and logs —
  the OE key and upstream URL are never echoed in responses.

`/rooftop` (30-min) is a deliberate follow-up; see the project task.

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

### Verify before wiring the frontend

```bash
curl "https://nemweb-proxy.<account>.workers.dev/demand?region=NSW1\
&from=2026-06-01T00:00:00+10:00&to=2026-06-01T00:30:00+10:00"
```

You should get JSON with a non-empty `points` array. If `points` is empty or
the request 502s with an auth error, the OE request shape needs adjusting —
edit **only** `oeDemandUrl` and `parsePoints` in `src/index.ts` to match the
live OE response, then redeploy. (The shape in the code follows OE's documented
v4 convention but could not be verified offline.)

**Then send the Worker URL back** — it becomes a build-time constant in the
frontend (`NEXT_PUBLIC_WORKER_URL`), which is the next step.

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
