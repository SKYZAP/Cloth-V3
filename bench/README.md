# The release benchmark

**Tests** (`.github/workflows/tests.yml`) run on GitHub's own runners for every push to master and every pull
request: typecheck and the vitest suite, with results in the run's summary.

The **release benchmark** (`.github/workflows/bench.yml`) runs on the maintainer's self-hosted runner (label
`cloth-pi`, a Raspberry Pi): after each run of the Release workflow, for the release it
  made. Also by hand for any release tag (Actions → Release benchmark → Run workflow: tag, force, arms, tasks, time
  limit), which is how older releases get graded. A release that already has a result is skipped unless "force" is on.

Dashboard: `BENCH_HOME/site`, served by any static file server, one entry per release (`#v1.5.0`), newest first.
Set the repository variable `BENCH_URL` to where it is served, and the run's GitHub summary links to it. The summary
has the table either way, also when the run stopped early. Pull requests never start the benchmark.

The scoring scripts (`bench/`) always come from master and the app from the release tag, so every release is graded
the same way. Releases made from the Actions tab don't send a `release` event, which is why the benchmark follows the
Release workflow rather than the event.

## What it does

Each arm gets the same request with GPT-6 Luna at medium effort, and is scored with tests it never sees:

| Task | Starts from | Scored with |
|---|---|---|
| Berdbot queue commands (`tasks/berdbot`) | Berdbot at `0e0008c` | `hidden.spec.ts` (21 Jest tests), plus its own tests, `npm run build`, ESLint on changed files |
| Order reconciler (`tasks/recon`) | an empty git repo | `acceptance.test.mjs` (20 node:test tests), plus its own `npm test` |
| Todo: due dates and tags (`tasks/todo`) | `seed/`, a small todo CLI | `hidden.test.mjs` (20 node:test tests: the new behaviour with its exact texts, the v1 → v2 file format, and the old commands unchanged), plus its own `npm test` |
| Invoice refactor (`tasks/invoice`) | `seed/`, one quirky invoice module | `hidden.test.mjs` (18 node:test tests: the module split, and every result compared with the original, `reference.mjs`, on the same inputs, quirks included, plus the new `taxes`), plus its own `npm test` |

The last two are shaped for Spec → Ship: a feature across several parts of a project (its Standard route), and a
refactor whose behaviour must not change (its Preserve route). The prompts don't list the invoice module's quirks; a
mode has to pin today's behaviour itself to keep them.

Arms: Cloth Chat, Plan, Spec → Ship and OpenSpec (through `CLOTH_PROBE=modes`, which answers every question with the
agent's own recommendation and approves every gate), and OMP default and plan-yolo. OMP is pinned by `OMP_VERSION` in
`bench.yml`. It runs until it has 3 results per task and arm (`OMP_RUNS_PER_VERSION`); after that its results are
reused (marked "reused" on the dashboard), since OMP didn't change. Bump `OMP_VERSION` to measure a new OMP.

A release costs about $0.60–0.80 in API calls once OMP is reused and takes 2–3 hours on the Pi; each run is capped at
60 minutes.

## Files on the runner (`BENCH_HOME`, `~/cloth-bench`)

| Path | What |
|---|---|
| `fixtures/berdbot.bundle` | Berdbot's history up to the base commit (`git bundle`, branch `bench-base`) |
| `site/` | The dashboard: `index.html` (copied from `bench/site` each run) and `data/` (one JSON per benchmark) |
| `results/<release>/` | Logs, transcripts and patches of the last 14 benchmarks |
| `omp-cache/<version>/` | OMP's results per version |
| `bin/` | OMP release binaries (checked against the release's SHA256SUMS) |
| `work/` | Workspaces while a benchmark runs |

The runner is `~/actions-runner`, run by the user service `actions-runner` (`systemctl --user status actions-runner`;
lingering is on, so it starts at boot without a login).

## Setting it up again

1. Runner: download `actions-runner-linux-arm64` into `~/actions-runner`, then
   `./config.sh --url https://github.com/<owner>/<repo> --token <registration token> --name cloth-pi --labels cloth-pi`
   and install the user service above.
2. Secret: `gh secret set OPENAI_API_KEY --repo <owner>/<repo>`.
3. Fixture: `git bundle create berdbot.bundle bench-base` in a Berdbot clone with `bench-base` at `0e0008c`, copied to
   `fixtures/`.
4. Site: serve `site/` with any static file server, and set `BENCH_URL` to its address.

## Running it by hand

On the runner, with a built Cloth (`npm ci && npx electron-vite build`) in `$CLOTH`:

```bash
OPENAI_API_KEY=… OMP_VERSION=18.20.2 CLOTH_DIR=$CLOTH BENCH_RELEASE=v1.5.0 BENCH_ARMS=cloth-chat BENCH_TASKS=recon node bench/run.mjs
```

Without `BENCH_RELEASE` the result is saved as `<date>-<commit>`.
