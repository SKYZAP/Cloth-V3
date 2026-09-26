# ADR 0001 — Agent runtime: pi-agent-core in-process (not oh-my-pi)

Status: accepted (revisit when oh-my-pi ships a Node-compatible build or an RPC mode we want)

## Context

Cloth's agent chat should be "powered by oh my pi / pi". The options:

| | `@mariozechner/pi-agent-core` + `pi-ai` (in-process) | `@oh-my-pi/pi-coding-agent` (subprocess) |
|---|---|---|
| Runtime | Node ≥ 20 — runs inside Electron's main process | **Bun ≥ 1.3.14 only** — cannot load in Electron's Node |
| Integration | Direct API: `Agent`, `subscribe()` events, typed tools | Spawn a Bun binary, talk JSON-RPC / stdio, map its events |
| Tools | Ours: `rag_search`, `skill_list`, `skill_use`, scoped read-only fs | Its own coding toolset (edit, bash, LSP, subagents…) |
| Traces | Native `tool_execution_*` events + `details` payload for RAG references | Must translate its session format into our trace UI |
| Providers | `pi-ai` Model objects built from our provider registry (OpenAI Responses, Anthropic Messages, OpenAI-compatible with `compat` flags) | Its own provider config — would duplicate ours |
| Packaging | Nothing extra | Ship/locate a Bun runtime per platform |

## Decision

Run **pi-agent-core** in the Electron main process. `AgentRuntime` (src/main/agent/chat.ts) builds a pi `Agent`
per chat turn from the session's model, system prompt and tool scope; `toUiMessages()` folds pi's
`AgentMessage[]` into UI turns with interleaved thinking / text / tool traces. Pi messages are persisted as-is,
so sessions replay exactly into the next turn.

## Consequences

- One process, no Bun dependency, provider registry shared with RAG, workflows, skills and MCP.
- We don't get oh-my-pi's heavyweight coding tools (file editing, shell, LSP). Workspace access is read-only today.
- Swap path: `AgentRuntime` is the seam. An `OmpRuntime` could spawn `omp` in RPC mode for "coding agent" chats and
  map its events onto the same `UiMessage` / `ToolTrace` shape, selectable per chat.
