# Cloth

An offline developer hub, built as an Electron desktop app. The theme is black and grey with crimson highlights.

## Architecture

- **Electron main (Node 24)** runs every service in-process. Storage is `node:sqlite` with FTS5, so there are no native modules and no sidecars.
- **Agent runtime:** `@mariozechner/pi-agent-core` and `pi-ai` run in-process. oh-my-pi (`@oh-my-pi/pi-coding-agent`) needs **Bun ≥1.3.14**, so it can't run inside Electron's Node. It could be added later as an external RPC runtime.
- **Renderer:** React 19, Tailwind v4, @xyflow/react and CodeMirror. It talks to main through one typed IPC proxy (`src/shared/api.ts`).

| Area | Location | Status |
|---|---|---|
| Providers (OpenAI, Anthropic, OpenAI-compatible: LM Studio, Ollama, llama.cpp, vLLM, OpenRouter) | `src/main/providers` | backend done |
| Agent chat (pi agent, tool traces, RAG references, workspace read tools) | `src/main/agent` | backend done |
| Hybrid RAG (BM25 + vectors with RRF, per-document cap) and agentic mode (plan, reflect, rerank). Indexes files, folders, PDF, DOCX, URLs with crawl, and text | `src/main/rag` | backend done |
| Skill hub (SKILL.md folders, import and export, evals, LLM judge, baseline check, freshness audit giving a verdict: fresh, stale, failing or redundant) | `src/main/skills` | backend done |
| Workflows (DAG engine with condition branches, templates, LLM, agent, RAG, skill, HTTP and JS nodes; cron via croner) | `src/main/workflows` | backend done |
| MCP server (Streamable HTTP at `http://127.0.0.1:7811/mcp`): `skill_list`, `skill_use`, `rag_search`, `rag_collections` | `src/main/mcp` | backend done |
| UI pages | `src/renderer` | **in progress:** theme and lib are done, pages not yet written |

## Dev

```bash
npm install
npm test        # vitest: core logic
npm run dev     # needs the renderer pages (src/renderer/src/main.tsx) to be written first
```

## Next steps

1. Renderer: `main.tsx`, `App.tsx` (title bar and nav rail), UI primitives and a ModelPicker, then the pages: Chat, Knowledge, Skills, Workflows, Providers, MCP, Settings.
2. Run `npm run typecheck` and `npm run dev` for an end-to-end smoke test against LM Studio.
3. Packaging with electron-builder, and an app icon in `resources/`.
