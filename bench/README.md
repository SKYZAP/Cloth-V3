# Nightly benchmark and CI on the Pi

Two GitHub Actions workflows run on a self-hosted runner on the Raspberry Pi (`cloth-pi`, 192.0.2.10):

- **Tests** (`.github/workflows/tests.yml`): every push to master. Typecheck and the vitest suite in a `node:22`
  container. Results are in the run's summary.
- **Nightly benchmark** (`.github/workflows/bench.yml`): 02:00 Malaysia time, and on demand (Actions → Nightly
  benchmark → Run workflow, where you can pick arms, tasks and the time limit). A scheduled run skips a commit that
  already has a finished night.

Dashboard: **http://bench.example.internal**. Each night has its own link (`#<night id>`).

## What the benchmark does

Each arm gets the same request with GPT-6 Luna at medium effort, and is scored with tests it never sees:

| Task | Starts from | Scored with |
|---|---|---|
| Berdbot queue commands (`tasks/berdbot`) | Berdbot at `0e0008c` | `hidden.spec.ts` (21 Jest tests), plus its own tests, `npm run build`, ESLint on changed files |
| Order reconciler (`tasks/recon`) | an empty git repo | `acceptance.test.mjs` (20 node:test tests), plus its own `npm test` |

Arms: Cloth Chat, Plan, Spec → Ship and OpenSpec (through `CLOTH_PROBE=modes`, which answers every question with the
agent's own recommendation and approves every gate), and OMP default and plan-yolo. OMP is pinned by `OMP_VERSION` in
`bench.yml`. It runs until it has 3 results per task and arm (`OMP_RUNS_PER_VERSION`); after that its results are
reused (marked "reused" on the dashboard), since OMP didn't change. Bump `OMP_VERSION` to measure a new OMP.

A night costs about $0.60–0.80 in API calls once OMP is reused and takes 2–3 hours on the Pi; each run is capped at
60 minutes.

## Files on the Pi (`BENCH_HOME`, `/home/pi/cloth-bench`)

| Path | What |
|---|---|
| `fixtures/berdbot.bundle` | Berdbot's history up to the base commit (`git bundle`, branch `bench-base`) |
| `site/` | The dashboard: `index.html` (copied from `bench/site` each night) and `data/` (one JSON per night) |
| `site-server/docker-compose.yml` | Caddy serving `site/` at bench.example.internal through Traefik (`bench/site/docker-compose.yml`) |
| `results/<night>/` | Logs, transcripts and patches of the last 14 nights |
| `omp-cache/<version>/` | OMP's results per version |
| `bin/` | OMP release binaries (checked against the release's SHA256SUMS) |
| `work/` | Workspaces while a night runs |
| `npm-cache/` | npm's cache for the Tests container |

The runner is `~/actions-runner`, run by the user service `actions-runner` (`systemctl --user status actions-runner`;
lingering is on, so it starts at boot without a login).

## Setting it up again

1. Runner: download `actions-runner-linux-arm64` into `~/actions-runner`, then
   `./config.sh --url https://github.com/SKYZAP/Cloth-V3 --token <registration token> --name cloth-pi --labels cloth-pi`
   and install the user service above.
2. Secret: `gh secret set OPENAI_API_KEY --repo SKYZAP/Cloth-V3`.
3. Fixture: `git bundle create berdbot.bundle bench-base` in a Berdbot clone with `bench-base` at `0e0008c`, copied to
   `fixtures/`.
4. Site: copy `bench/site/docker-compose.yml` to `site-server/` and `docker compose up -d`.

## Running it by hand

On the Pi, from a Cloth checkout after `npm ci && npx electron-vite build`:

```bash
OPENAI_API_KEY=… OMP_VERSION=18.20.2 BENCH_ARMS=cloth-chat BENCH_TASKS=recon node bench/nightly.mjs
```
