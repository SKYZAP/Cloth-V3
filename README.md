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
  hover cards, per-chat knowledge scope, skills toggle, read-only workspace tools, regenerate, stop.
- **Hybrid & agentic RAG** — index files, folders (code-aware), PDF, DOCX, HTML, URLs (with crawl) and pasted text.
  Markdown-aware chunking with heading paths. SQLite FTS5 BM25 + embeddings fused with reciprocal-rank fusion
  and per-document diversity. *Agentic* mode: LLM query planning → multi-query retrieval → reflection with
  follow-up queries → LLM rerank. Search playground shows keyword/vector ranks.
- **Skill hub** — Agent-Skills compatible folders (`SKILL.md` + files). Create/edit with live preview, import
  from `~/.claude/skills`, `~/.agents/skills`, … or any folder, install into other tools. **Staleness testing**:
  eval cases (write or AI-draft), LLM judge, optional no-skill baseline and a freshness audit →
  verdict `fresh | stale | failing | redundant`, with regression detection against earlier runs.
- **Workflows** — node editor (React Flow): Trigger, LLM, Agent, Knowledge search, Skill, HTTP, JS Transform,
  Condition (true/false branches), Output. `{{key.path}}` templating, cron scheduling (croner), live node status
  on the canvas, run history with per-node input/output traces.
- **MCP server** — Streamable HTTP on `http://127.0.0.1:7811/mcp` with `skill_list`, `skill_use`, `rag_search`,
  `rag_collections`. Optional bearer token, localhost-only, call log, copy-paste client configs.

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
npm run smoke      # builds, starts scripts/mock-llm.mjs, drives the real app, screenshots → .cloth-dev/smoke
npm run package    # unpacked build in release/   (npm run dist for installers)
```

No model server handy? `npm run mock-llm` starts an OpenAI-compatible mock on `http://127.0.0.1:5055/v1`
(`mock-chat` streams + calls `rag_search`, `mock-embed` returns hashed vectors) — add it as a Custom provider.

## Known limits / next steps

- Brute-force vector search is fine to ~100k chunks per collection; beyond that add `sqlite-vec`.
- Workspace tools are read-only; an oh-my-pi RPC runtime could provide full coding tools (see ADR).
- Workflow graphs are acyclic (no loops yet); Transform/Condition use `node:vm`, which is not a security sandbox.
- MCP transport is HTTP only; stdio clients bridge with `mcp-remote` (snippet on the MCP page).
