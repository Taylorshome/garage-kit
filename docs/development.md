# Local development and tests

Everything below runs on your computer with `wrangler dev` and a local D1/KV; nothing touches a Cloudflare account.

## Demo (fake data)
```bash
npm ci
GARAGE_PASSWORD='choose-a-local-password' npm run demo
```
`npm run demo` = `configure --local` (writes a local-only `wrangler.jsonc`), local D1 migrations, `.dev.vars` with a
session secret and the password hash, the demo vehicles (`scripts/seed-demo.mjs --all`: a made-up 2015 sedan with
history, symptoms, research, brands and a diagnosis plan; a 2007 Yamaha V Star 650 with real public research for the
model, its shaft-drive schedule, the JASO wet-clutch oil flag and a hard-starting plan; and a side-by-side serviced by
engine hours, which gets the built-in CVT-belt and overheating plans), then `wrangler dev`. Open
http://localhost:8787 and sign in. Only some of them: `npm run seed-demo -- --bike --utv` (the sedan always comes
along; each vehicle is added once).

The demo uses a **mock AI** (canned answers labelled "AI mock"), because Workers AI only runs on a real account,
even in `wrangler dev`. For real AI answers locally: `npx wrangler login`, then `node scripts/configure.mjs --local`
(without `--mock-ai`) and `npm run dev`; AI calls then use your account's Workers AI allowance.
Other sign-in modes locally: `--mode=none` (also `cloudflare-access` / `oidc` with their settings in the config).

## Tests
```bash
npm test             # Node unit tests (node:sqlite as D1, faked Workers AI) + the research worker's Python tests
```

End to end against local `wrangler dev` (sign-in, VIN decode via the public NHTSA API, add car, catch-up, logging,
symptoms with the mock AI note, .glb upload, the full MCP OAuth flow and every main tool, guided diagnosis, the
disclaimer acknowledgement, disconnect, and vehicle types: the demo bike and UTV, adding a bike and a UTV, engine hours
moving a due item from ok to soon to overdue and back, `update_hours`, hours on `log_service`, a UTV diagnosis via MCP,
CPSC recalls):
```bash
node scripts/configure.mjs --local --mock-ai
npx wrangler d1 migrations apply DB --local && node scripts/seed-demo.mjs --bike --utv
GARAGE_PASSWORD='kit-test' node scripts/secrets.mjs --local
npx wrangler dev --port 8787 &
GARAGE_PASSWORD='kit-test' node scripts/e2e-local.mjs
# no-sign-in mode:
node scripts/configure.mjs --local --mock-ai --mode=none   # restart wrangler dev
node scripts/e2e-local.mjs --none
```
`e2e-local.mjs` refuses to run against anything but 127.0.0.1/localhost.

Docker image, same end-to-end test against the container:
```bash
docker build -t garage-kit:dev .
mkdir -p /tmp/gk && docker run -d --name gk -p 127.0.0.1:8788:8787 -v /tmp/gk:/data -e GARAGE_PASSWORD=kit-test -e AI_PROVIDER=mock garage-kit:dev
docker exec gk node scripts/seed-demo.mjs --bike --utv
E2E_BASE=http://127.0.0.1:8788 GARAGE_PASSWORD=kit-test node scripts/e2e-local.mjs
```
Without Docker, the same runtime: `npm run docker:bundle && DATA_DIR=/tmp/gk GARAGE_PASSWORD=kit-test AI_PROVIDER=mock npm run docker:start`.

3D previews of the six body styles: `python3 -m http.server` in the kit root, then open `/tools/model-grid.html`
(`?view=side|front34|rear34`, `&testglb=1` for an uploaded-model test). Motorcycles, UTV and ATV:
`/tools/vehicle-grid.html?ids=cruiser,sport,dualsport,scooter,utv,atv` (`?lineup=pickup,cruiser,atv,utv` for scale).

## Layout
See CLAUDE.md ("Map"). Migrations are additive and run in order (`migrations/NNNN_*.sql`); a new feature adds a new
file, never edits an old one.
