# Cloth user guide

Cloth is an offline developer hub. Everything runs on your machine: model providers, the agent, the knowledge base, the skill hub, workflows, tools, web search and an MCP server.

## Providers and models

Open **Models** to register a provider.

- **OpenAI** uses the Responses API; **Anthropic** uses the Messages API. Both need an API key.
- **OpenAI-compatible** covers LM Studio (`http://localhost:1234/v1`), Ollama (`http://localhost:11434/v1`), llama.cpp, vLLM and OpenRouter.
- Click **Fetch** to list models. Tick **Embed** for embedding models, **Reason** for models that think, **Vision** for image input.
- Pick a **default chat model** and a **default embedding model** at the top of the page. Workflows, agentic search and skill tests fall back to the default chat model.
- API keys are encrypted with the operating system keychain.

## Agent chat

Each chat has its own model, knowledge scope and tool switches.

- The icons under the composer toggle **skills**, **web** and **custom tools**; the **books**, **folder** and **brain** icons open the chat-context sheet for knowledge collections, the workspace folder and the thinking level.
- Type **/** in the composer to invoke a skill directly: pick it from the menu (arrow keys and Enter), and its instructions are sent with that message. Invoked skills appear as chips; Backspace at the start of the box removes the last one.
- Every tool call appears as a trace card with its arguments, result, duration and status. Click a card to expand it.
- When the agent searches the knowledge base or the web, results appear as numbered references. Citations such as `[2]` in the answer show the source on hover.
- **Regenerate** reruns the last question; **Stop** aborts a running turn.
- A **workspace folder** gives the agent read-only `list_dir`, `read_file` and `grep` tools.

## Knowledge (RAG)

Collections hold documents. Add files, whole folders (code-aware), PDFs, Word documents, web pages (with optional crawling) or pasted text.

- Documentation sites built with React, Angular or Vue send an empty page until JavaScript runs. Cloth detects that and renders those pages with its bundled Obscura browser (**JS rendering: Auto**); **Always** renders every page, **Off** uses plain HTTP only.
- A page or file with no readable text is marked as an error rather than indexed empty.

- Documents are split into chunks along Markdown headings. Each chunk keeps its heading path, for example `Guide › Install`.
- **Keyword** search uses SQLite FTS5 with BM25 ranking.
- **Vector** search needs an embedding model on the collection.
- **Hybrid** search fuses keyword and vector rankings with reciprocal-rank fusion (RRF) and caps results per document for diversity.
- **Agentic** search asks the model to plan several sub-queries, checks whether the results cover the question, runs follow-up queries if not, and reranks the candidates.
- Changing a collection's embedding model drops its vectors. Use **Embed missing** to rebuild them.

## Skills

A skill is a folder with a `SKILL.md` file: YAML front matter (`name`, `description`) followed by Markdown instructions. Extra files in the folder are loaded on demand.

- Import skills from `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills` or any folder, and install hub skills into those folders.
- **Tests** run eval cases against a model. A judge model grades each expectation.
- Turn on **Baseline** to rerun each case without the skill, and **Freshness audit** to have the model look for deprecated APIs or outdated advice.
- Verdicts: **fresh** (passes, nothing outdated), **stale** (score below 80%, a drop of 20 points since the last run, or a high-severity audit finding), **failing** (under 50%), **redundant** (the model does as well without the skill).

## Tools

The **Tools** page lists the built-in tools (read-only) and your custom tools.

- **HTTP** tools call an API. URL, headers and body are templates, for example `https://api.example.com/items/{{id}}`.
- **JavaScript** tools run an async function body with `args`, `fetch` and `console` in scope and must return a value.
- **Command** tools run an executable with one argument per line. There is no shell, so parameter values cannot inject extra commands.
- **Prompt** tools call a model with a templated prompt.
- Every tool has a **Test** panel. Enabled custom tools are offered to chats (when the custom tools chip is on) and to workflow agent nodes.

## Web search

Cloth ships two engines; pick one in **Settings → Web search**.

- **Obscura** is a stealthy headless browser. Cloth runs `obscura fetch` against the DuckDuckGo HTML results page. It starts instantly and also renders pages for `web_fetch`.
- **SearXNG** is a metasearch engine that queries several search engines at once. Cloth starts its bundled copy on first use (a few seconds), bound to 127.0.0.1. You can point Cloth at an external SearXNG instance instead.
- `web_fetch` blocks localhost and private network addresses unless you allow them in Settings.

## Workflows

Workflows are graphs of nodes: Trigger, LLM, Agent, Knowledge search, Web search, Skill, Custom tool, HTTP, Transform, Condition and Output.

- Templates reference data with `{{input.field}}` (run input), `{{prev}}` (the node feeding in) and `{{key}}` or `{{key.field}}` (any earlier node by its key).
- Condition nodes branch through their **true** and **false** handles; nodes on the untaken branch are skipped.
- Add a cron expression and switch on **Scheduled** to run automatically. For example `0 9 * * 1-5` runs at 09:00 on weekdays.
- **Assemble with AI** describes a workflow in plain language and lets an agent build (or modify) the graph, which you review before saving.

## MCP server

Cloth hosts an MCP server at `http://127.0.0.1:7811/mcp` with `skill_list`, `skill_use`, `rag_search`, `rag_collections` and `web_search`.

- Claude Code: `claude mcp add --transport http cloth http://127.0.0.1:7811/mcp`
- Cursor: add the URL under `mcpServers` in `~/.cursor/mcp.json`.
- Clients that only speak stdio can bridge with `npx mcp-remote <url>`.
- Turn on **Require bearer token** to demand `Authorization: Bearer <token>`.
