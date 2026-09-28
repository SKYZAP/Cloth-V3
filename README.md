# Cloth

An **offline developer hub** desktop app: register model providers, chat with a traced agent grounded in your
own knowledge base, curate and test a central skill library, automate with scheduled workflows, and expose it
all to other tools over MCP. Black/grey UI with crimson highlights.

## Features

- **Providers** — OpenAI (Responses API), Anthropic (Messages API) and any OpenAI-compatible server: LM Studio,
  Ollama, llama.cpp, vLLM, OpenRouter. Model discovery (LM Studio metadata aware), per-model flags
  (embedding / reasoning / vision), ping, default chat + embedding model. Keys encrypted via OS keychain.
- **Agent chat** — powered by `pi-agent-core` ([ADR](docs/adr-0001-agent-runtime.md)). Streaming, thinking
  blocks, collapsible tool-call traces (args, result, duration, status), RAG references with `[n]` citation
  hover cards, per-chat knowledge scope, skills toggle, read-only workspace tools, regenerate, stop. Type `/` to
  invoke a skill for a message.
- **Coding agent** — with a workspace folder the chat agent can read, search and (if allowed) edit files and run
  commands: pi's coding tools (read/ls/find/write/edit, bash or PowerShell) confined to the folder, approval cards
  with diffs, per-step checkpoints with Undo, ast-grep structural search/rewrite (TS/JS/HTML/CSS/Python/Go/Rust/Java),
  LSP code intelligence (TypeScript 7 native server, Pyright) with type errors fed back after each edit, subagents
  (`task`: scouts and workers, in parallel), a `todo_write` plan, and automatic conversation summarising.
- **Hybrid & agentic RAG** — index files, folders (code-aware), PDF, DOCX, HTML, URLs (parallel crawl; client-rendered
  docs sites are rendered with the bundled Obscura browser automatically) and pasted text.
  Markdown-aware chunking with heading paths. SQLite FTS5 BM25 + embeddings fused with reciprocal-rank fusion
  and per-document diversity. *Agentic* mode: LLM query planning → multi-query retrieval → reflection with
  follow-up queries → LLM rerank. Search playground shows keyword/vector ranks.
- **Skill hub** — Agent-Skills compatible folders (`SKILL.md` + files). Create/edit with live preview, import
  from `~/.claude/skills`, `~/.agents/skills`, … or any folder, install into other tools. **Staleness testing**:
  eval cases (write or AI-draft), LLM judge, optional no-skill baseline and a freshness audit →
  verdict `fresh | stale | failing | redundant`, with regression detection against earlier runs.
- **Workflows** — node editor (React Flow): Trigger, LLM, Agent, Knowledge search, Web search, Skill, Custom tool,
  HTTP, JS Transform, Condition (true/false branches), Loop (for-each / repeat-until with a loop-back edge), Output.
  **Arrange** auto-lays out the graph (layered, crossing-reduced); run output opens in a Markdown viewer. `{{key.path}}` templating, cron scheduling (croner),
  live node status on the canvas, run history with per-node input/output traces. **Assemble with AI**: describe a
  workflow (or a change to one) and a pi agent builds it with `add_node` / `connect` / `finish` tools, validating
  structure and references as it goes; the result opens in the editor for review.
- **Tools** — built-in tools listed read-only (schema, availability); custom tools of four kinds — HTTP, JavaScript,
  command (no shell; one templated argv entry per line) and prompt — with a live test runner. Enabled custom tools
  are offered to chats and workflow agent nodes.
- **Web search** — `web_search` / `web_fetch` tools with two bundled engines, switchable in Settings:
  **Obscura** (stealth headless browser; `obscura fetch` against DuckDuckGo's HTML results, also renders pages) and
  **SearXNG** (metasearch; bundled CPython sidecar started on demand on 127.0.0.1, or point at an external instance).
  `web_fetch` blocks private-network targets unless allowed.
- **Example knowledge** — bundled docs (Cloth user guide, Git, HTTP/REST, regex, cron, SQL) seeded into a
  "Cloth examples" collection on first run, re-loadable from the Knowledge page.
- **Dashboard** — tokens, estimated cost (built-in price list or per-model prices), model calls, latency, failures,
  most used tools and skills, usage by source (chat / flows / skill tests / knowledge / MCP), busiest hours, flow
  success rates and skill health. Backed by a local usage log (`usage_events`), attributed with AsyncLocalStorage.
- **MCP server** — Streamable HTTP on `http://127.0.0.1:7811/mcp` with `skill_list`, `skill_use`, `rag_search`,
  `rag_collections`, `web_search`. Optional bearer token, localhost-only, call log, copy-paste client configs.

## Architecture

```
Electron main (Node 24)                                  Renderer (React 19 + Tailwind v4)
├─ core/        node:sqlite (FTS5, WAL), kv settings     ├─ pages/  Chat · Knowledge · Skills · Flows
├─ providers/   registry → pi-ai Model, embeddings       │          Models · MCP · Settings
├─ agent/       pi-agent-core runtime, tools, sessions   ├─ components/  ui kit, ModelPicker, Markdown,
├─ rag/         extract → chunk → BM25 + vectors → RRF   │               ToolTrace, CodeMirror editor
├─ skills/      SKILL.md hub, evals, judge, audit        └─ lib/  typed IPC proxy (ClothApi), zustand
├─ workflows/   DAG engine + croner scheduler
└─ mcp/         MCP SDK, stateless Streamable HTTP        src/shared/  api.ts contract + domain types
```

No native modules, no sidecars: storage is Node's built-in SQLite, vectors are Float32 blobs searched in memory.
Data lives in the app's userData folder (`%APPDATA%/Cloth`, or `Cloth-dev` when unpackaged).

## Development

```bash
npm install
npm run dev        # electron-vite with HMR
npm test           # vitest: chunker, engine, skills, RAG, pi agent traces, MCP protocol + auth
npm run typecheck
npm run sidecars   # stage Obscura + SearXNG into sidecars/ (pinned, sha256-verified; cached)
CLOTH_LIVE_WEB=1 npx vitest run tests/sidecars.test.ts   # live checks against the staged engines
npm run smoke      # builds, starts scripts/mock-llm.mjs, drives the real app, screenshots → .cloth-dev/smoke
npm run package    # stages sidecars, then an unpacked build in release/   (npm run dist for installers)
```

### Bundled sidecars

| Engine | Pinned | Staged by | Shipped as |
|---|---|---|---|
| Obscura | v0.2.3 `no-render-stealth` build (all 5 desktop targets, sha256 per asset) | `scripts/stage-obscura.mjs` | `resources/obscura/` |
| SearXNG | commit `cd75013c`, CPython 3.12.13 (python-build-standalone 20260303) | `scripts/stage-searxng.mjs` | `resources/searxng/` |

SearXNG's settings template is `resources/searxng/settings.yml` (loopback bind, JSON format on, per-install secret
filled in at launch). Brave / DuckDuckGo / Startpage often CAPTCHA desktop IPs and Bing's HTML endpoint serves
unrelated results to scrapers, so Bing is off, Google / Mojeek / Wikipedia / GitHub / MDN are on, Cloth queries the
`general` and `it` categories, and results sharing no terms with the query are dropped. Result quality still depends
on which upstream engines answer from your network — Obscura is the default engine for that reason.

No model server handy? `npm run mock-llm` starts an OpenAI-compatible mock on `http://127.0.0.1:5055/v1`
(`mock-chat` streams + calls `rag_search`, `mock-embed` returns hashed vectors) — add it as a Custom provider.

## Releasing

`.github/workflows/release.yml` builds the Windows installer (`Cloth-Setup-<version>.exe`) and macOS disk images for
Apple silicon and Intel (`Cloth-<version>-mac-arm64.dmg`, `Cloth-<version>-mac-x64.dmg`) and attaches them to a GitHub release:

- **Publish a release** with a tag like `v1.2.0`: the workflow builds that tag and uploads the installers.
- **Run it manually** (Actions → Release → Run workflow) with a version such as `1.2.0`: it creates release `v1.2.0`
  from the selected branch if it doesn't exist (optionally as a pre-release), or re-uploads the installers to it.

Each platform builds on its own runner (the bundled sidecars, TypeScript server and ast-grep are native per architecture),
after typecheck and tests. Builds are unsigned unless signing secrets are set — see the comment at the top of the workflow.

## Known limits / next steps

- Brute-force vector search is fine to ~100k chunks per collection; beyond that add `sqlite-vec`.
- Workspace tools are read-only; an oh-my-pi RPC runtime could provide full coding tools (see ADR).
- Workflow graphs are acyclic (no loops yet); Transform/Condition nodes and JavaScript tools use `node:vm`, which is
  not a security sandbox.
- The installer grows by ~230 MB for the two web engines (mostly CPython + Obscura's embedded V8).
- MCP transport is HTTP only; stdio clients bridge with `mcp-remote` (snippet on the MCP page).
