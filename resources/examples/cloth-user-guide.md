# Cloth user guide

Cloth is a desktop workbench for AI work. You chat with any model, let agents work on your files, give them your own documents, build skills and tools, automate tasks, and run local models, all from one app. Chats, documents, skills and settings stay on your computer: in `%APPDATA%\Cloth` on Windows and `~/Library/Application Support/Cloth` on macOS. The only things that leave it are requests to the model providers and websites you use.

The sidebar lists every page: Dashboard, Chat, Boards, Swatches, Automations, Agents, Skills, Tools, Knowledge, Models, Run, MCP servers and Settings.

## First-run setup

The first time Cloth opens, a short setup walks you through:

- **Model:** add a provider or pick a local model to chat with.
- **Main working folder:** new chats start in it (not chats in a project or a container).
- **Languages:** the ones you pick decide which language servers Cloth may start (gopls for Go, rust-analyzer for Rust, clangd for C/C++ and jdtls for Java), with optional best-practice skills for them. A missing server has an **Install** button. Change languages later in **Settings → Languages**.
- **Tools check:** which programs Cloth found on your computer (Git, GitHub CLI, Docker, Node.js, Python and others).
- **Import:** copy skills, agents and MCP servers from Claude Code, Claude Desktop, Cursor and Codex. Imported MCP servers arrive switched on and start right away; their tools ask before running, and their secrets never reach the app window.
- **Ways to work:** which way of working suits you (see below).

**Set up later** leaves a card on the Dashboard. **Settings › Data & about › Run setup again** starts it over.

## Which way to work

- **Chat:** quick, simple fixes. A bug, a rename, a question about the code; the agent works directly and shows each change.
- **OpenSpec:** fixes that need a plan first. It writes a short proposal and task list, implements it once agreed, and commits it to a branch for you to review.
- **Spec → Ship:** large features and risky changes. It works in stages (questions, spec, tickets, build and review) and you sign off between them.
- **Boards:** a defined goal broken into tickets that agents pick up and move across the board. Best when you know the finish line.

## Providers and models

Open **Models** to add a provider.

- **OpenAI** uses the Responses API; **Anthropic** uses the Messages API. Both need an API key.
- **OpenAI-compatible** covers LM Studio (`http://localhost:1234/v1`), Ollama (`http://localhost:11434/v1`), llama.cpp, vLLM and OpenRouter.
- **Fetch list** lists a provider's models. Each model shows its context size and what it can do: **Reasoning**, **Vision**, **Embed** (embedding model) and **Images** (image generation). Click a chip to correct it.
- The star marks the default chat model. The bottom of the provider list shows which model does each job (chat, embeddings, images and chat titles); change them in **Settings › Models**.
- Set a price (USD per 1M input and output tokens) for models the built-in price list doesn't know; the Dashboard uses it for cost.
- API keys and secret headers are encrypted with your system keychain and are never shown in the app.

## Run: local models

The **Run** page serves local GGUF models with llama.cpp's `llama-server`, one runner per model. A running model is available in every chat like any other model.

- **Install** llama.cpp in one click (the upstream builds, or PrismML's fork) and update it from the same page.
- **Search models** finds GGUF models and marks how well each fits your hardware ("Fits on the GPU", "Fits on the GPU even at full length", or partial offload).
- Per runner, set the **context window** (up to the model's limit), the **reasoning level** for models that think (or turn thinking off), the context cache and extra server arguments.
- Downloads resume if interrupted. Reset Cloth can keep downloaded models.

## Image generation

Models marked **Images** generate pictures: OpenAI `gpt-image` and DALL·E, open models such as Flux or SDXL on compatible servers, and OpenRouter models that output images.

- **Generate** on an image model opens a playground: type a prompt, pick square, landscape or portrait.
- In a chat the agent can call `generate_image`. It uses the image model set in Settings › Models, or the first model marked Images. **Open** shows the image in your viewer; **Save as…** copies it anywhere.

## Chat

The Chat page has the chat list on the left, the conversation in the middle, and a side panel on the right.

### Starting and finding chats

- **Ctrl+N** (Cmd+N on macOS) starts a chat in the current chat's project; **Ctrl+K** jumps to the chat search; **Ctrl+B** hides or shows the chat list.
- Chats get a short AI-written title after the first answer (Settings › Chat › Name chats with AI).
- **Projects** group chats under a shared folder, instructions and starting settings. Make one from the chat list; new chats in it start in its folder with its settings.
- Chats are **archived** rather than deleted: **Ctrl+E** archives the open chat, with Undo. Archived chats sit in their own section. The chat's header menu has Rename, Move to project, Archive and Delete.

### The composer

- The model chip picks the model and **reasoning effort** for this chat. The figure next to it is what the chat has spent so far, including agents it handed work to. New chats start on the model you picked last, with the effort you last used for that model, and in Auto or Manual as you last set it.
- The **agent** picker sets which agent answers in this chat (Cloth by default, or one of your agents).
- Type **/** to invoke a skill directly; it shows as a chip and its instructions go with that message.
- Type **@** and an agent's name to hand the message to that agent.
- Attach files and images by dropping or pasting them.
- **Online / Offline** switches web search and page reading on or off.
- **This computer / Linux container** picks where commands run (see Containers below).
- **Computer use** lets the agent see the screen and use the mouse and keyboard (see below).

### Access: Manual, Auto and Plan

The access chip sets what the agent may do without asking:

- **Manual** asks before risky actions: deleting or writing outside the chat's folder, pushing to a remote, installing packages, and similar. Each ask says why it needs a look.
- **Auto** acts without asking.
- **Plan mode** is read-only. The agent explores, then proposes a plan with `present_plan`. Once you approve it, the chat goes back to Manual or Auto and carries it out.

### Working on files

Give a chat a folder (the folder icon, or a project) and the agent can work there.

- **Files: Read only** gives `read`, `ls`, `find` and `grep`. **Read and write** adds `write` and `edit`.
- **AST tools:** `ast_grep` searches code by structure with ast-grep patterns, such as `console.log($$ARGS)`; `ast_edit` rewrites every match (for example to `logger.debug($$ARGS)`), with one approval and one Undo. Languages: TypeScript, TSX, JavaScript, HTML, CSS, Python, Go, Rust and Java.
- **Code intel** starts language servers when first needed: bundled ones for TypeScript and Python, plus gopls, rust-analyzer, clangd or jdtls (Java) for the languages you picked. **Settings → Languages** installs, updates or removes Cloth's own copy of each (rust-analyzer and clangd from their official releases, jdtls from Eclipse, gopls built with your Go toolchain); a copy already on PATH works too, and Cloth's own copy is used first. jdtls needs Java 21 or newer and keeps its project data in Cloth's data folder; the first check in a Maven or Gradle project waits while it imports. The `lsp` tool gives diagnostics, go to definition, find references, hover types, outlines and project-wide rename. New type errors after a change go straight back to the agent.
- **Shell** runs commands in the folder: PowerShell 7 (or Windows PowerShell) on Windows, your login shell on macOS and Linux. On macOS the agent uses your login shell's PATH. With Git for Windows installed, Windows chats also get a **bash** tool (Git Bash) beside PowerShell; WSL's bash is never used.
  - `cd` carries over: the next command starts where the last one ended, as long as it stays inside the chat's folder. A command that leaves the folder sends the next one back to the folder itself. Approvals show the folder each command runs in.
  - **Background commands:** the agent starts dev servers, watchers and long builds with `run_in_background`, then reads their new output (`shell_output`) and stops them (`shell_stop`). Each one opens as a tab in the chat's **Terminal** panel with its live output: **Stop** on the tab ends it (the output stays to read), and closing the tab ends it too. They also stop when you stop or delete the chat or quit Cloth. They ask for approval like any other command.
- **Coding rules** (Settings › Coding rules) and a folder's `AGENTS.md` or `CLAUDE.md` are part of every agent's instructions there. ast-grep rule files (the folder's `sgconfig.yml`, and a global rules folder) are checked on every file the agent changes.
- Every change is checkpointed. Trace cards list the files changed with +/− counts; **Undo** restores them.
- File paths in replies are links: click one to open the file in the side panel.

### Agents in a chat

- The chat agent can hand a job to a subagent with the `task` tool, at an access level (Reader, Writer or Operator) and reasoning level that suits the job. Several run in parallel, each with a fresh context; each shows as a card that streams its steps and ends with its report.
- Settings › Subagents sets how many run at once, how many steps each may take, the most they may do, and the model that runs review checks.
- For multi-step work the agent keeps a **plan** with `todo_write`, pinned above the composer while it works, and can ask you questions with `ask_user`.
- The chat agent can also read your other chats (`session_list`, `session_read`) and set up agents, automations, MCP servers and model providers for you. In Manual it asks first.

### Long chats

Near the model's context limit, older turns are summarised (goal, progress, decisions, next steps). The ring next to Send shows how full the context is; click it to summarise now. Turn this off in Settings › Chat.

### Chat backgrounds

Settings › Chat › Background puts an animated background behind the conversation. Five built-in themes, one per style: **Crimson flow** (the default), **waves**, **mesh**, **swirl** and **halftone**. **Strength** sets how much shows through. Ask a chat for a new look ("make the background slower and blue") and it makes or adjusts a theme with its `chat_theme` tool. Backgrounds hold still when your system is set to reduce motion.

### The side panel

**Ctrl+.** shows or hides the side panel. A dock beside it shows running terminals, git changes, running agents and builds. Right-click a dock tab, or press Shift+Enter on it, to stack up to three tabs.

- **Setup:** the chat's agent, instructions and context, knowledge, skills, tools and MCP servers, with the token cost of each.
- **Terminal:** interactive shells in the chat's folder or container. **Ctrl+`** opens it. Copy with **Ctrl+C** when text is selected (otherwise it stops the running program) or **Ctrl+Shift+C**, and paste with **Ctrl+V**; on a Mac, **Cmd+C** and **Cmd+V**. The agent can read what a terminal shows (`terminal_read`), for example an error you want it to look at, but never types into it.
- **Files:** the folder's tree and a file viewer.
- **Git:** changes, staged and unstaged diffs, discard, an AI-written commit message, and commit.
- **Agents:** the subagents working for this chat.
- **Spec:** Spec → Ship's documents or the folder's OpenSpec changes, with a toggle between them. It follows the mode the chat is running.
- **Swatches:** the chat's swatches, live (see Swatches).

### Spec → Ship

A mode for building features properly. It asks clarifying questions, writes a spec and tickets, then builds them with agents and reviews the result.

- It picks the right route itself, and for a quick bug fix it diagnoses before changing anything.
- Workers build tickets in parallel, each in its own git worktree on its own branch, and their work merges back into the chat's branch. Unfinished work is kept on its branch.
- Review checks must prove each finding by running a command and showing its output.
- Several features can be built one after another in one chat, with a fresh context for each stage. The ticket board follows the build and ticks off finished tickets.
- At the end it commits the finished work and removes its worktrees and worker branches. Branches dropped with unmerged work are logged with their commit, so they can be restored.

### OpenSpec mode

Takes a change from proposal to a committed local branch with the OpenSpec command-line tool (it pushes and opens a pull request only when you ask for one), which ships with Cloth. A progress strip and step cards show where it is, and you can pause after Propose to review the proposal.

### Containers

Set a chat to **Linux container** to run its commands in Docker instead of on your computer. Cloth copies the folder in (skipping what `.gitignore` excludes), forwards ports the container opens, and offers the changes back to your real folder for review. Docker must be installed.

### Computer use

With computer use on, the agent sees the screen and controls the mouse and keyboard. A banner shows while it works, and a keyboard shortcut stops it at once. On macOS, grant Screen Recording and Accessibility when asked.

## Boards

**Boards** drives tracker tickets through agent stages: New, Requirements, Review, Building and PR open.

- Connect **Plane** or **Jira**, or use a **Cloth board**: an offline board in Cloth's own storage, with no account or token.
- A **planner** researches what the ticket depends on (web and docs) and writes requirements into it. A **reviewer** checks them against the goal. An **implementer** builds in its own copy of the code: a git worktree when the code folder is a git repository, otherwise a plain copy. Git is optional.
- **Edit project** sets a project's name, the agent for each step (Requirements, Review, Build: any of your agents, or the built-in ones) and its code folder. On a Cloth board it also deletes the project with its tickets.
- Per project, choose what agents may do: no commits (changes wait in their copy for you to apply), commit locally, or commit and open a PR. Commits and PRs need a git repository. Also: whether to sync ticket changes back to the tracker, whether to approve requirements before building, how many review rounds, and how many check fixes to try.
- When a PR fails its checks, the implementer reads the CI logs, finds the cause and pushes a fix to the same PR.
- Each feature lands as one conventional commit, with PRs titled `[Cloth][KEY] Title`.
- **Open in chat** starts a chat for a ticket with its requirements and PR in the message box.

## Swatches

A swatch is a page, document or image a chat publishes with `publish_swatch`: an HTML page, Markdown or SVG.

- It shows live in the conversation. **Open** shows it in the chat's Swatches tab; close it there to pick another of the chat's swatches.
- The **Swatches** page lists every swatch, with versions, renaming, a new link, and deletion.
- Each swatch has a private link. Turn on **Share on your network** to open it from phones and other computers on the same network.
- Swatches are served on port 7841. If another app (or another copy of Cloth) already uses it, the Swatches page says so; **Change the port** opens **Settings › Swatches**, where you can also turn network sharing on or off.
- Swatch pages run sandboxed: they can't read Cloth's data or each other's.

## Automations

An **automation** is a task an agent does on its own: a prompt with the tools, knowledge, folder and commands it may use.

- **New** drafts one from a description, such as "Every weekday at 8:30, run the tests in my project folder and explain any failures."
- **When it runs:** only when you run it, or on a schedule. It can also run when files in its folder change, a web page changes, or an MCP check changes.
- **Folder:** none, a folder on this PC, or an empty folder in a container (it starts with nothing, needs Docker, and keeps the files you keep from its runs).
- **Reports:** it reports in a chat (one per run, in the Automation project), with a desktop notification, or as a note in one of its knowledge collections.
- Risky actions are refused, since nobody is there to approve them.
- **Export as app** packages an automation as its own Windows installer to share.

## Agents

The **Agents** page lists Cloth's team on the left (Cloth, the built-in agents, then yours) and edits the selected one in place on the right. Cloth is the main agent in every chat; the others take jobs it hands out. A row says what each agent is working on right now.

- Built in: **Designer** (builds UI, following the project's design system), **Researcher** (searches the web and knowledge and cites sources; read-only) and **Code reviewer** (reports findings with file and line; never edits).
- Each agent has a purpose, instructions, an **access level** (Reader, Writer or Operator), a **reasoning level** (Low, Medium, High or Max), a model, and the skills, tools, servers and knowledge it can use.
- **New agent** drafts one from a sentence, or starts from a template. **Rewrite with AI** changes an agent's instructions on request, with Undo.
- Select **Cloth** (or **Compare all** under This week) to see the whole team side by side, with this week's jobs for each.

## Knowledge

Collections hold documents: files, whole folders (code-aware), PDFs, Word documents, web pages (with optional crawling) and pasted text.

- Pages built with React, Angular or Vue are rendered with the bundled Obscura browser (**JS rendering: Auto**); **Always** renders every page, **Off** uses plain HTTP.
- Documents are split along Markdown headings; each chunk keeps its heading path, such as `Guide › Install`. Settings › Knowledge sets chunk size and overlap.
- **Keyword** search uses SQLite FTS5 with BM25 ranking. **Vector** search needs an embedding model on the collection. **Hybrid** fuses both. **Agentic** search plans several sub-queries, checks coverage, runs follow-ups and reranks.
- **Ask** answers a question from your collections with citations.
- Changing a collection's embedding model drops its vectors; **Embed missing** rebuilds them.
- The **Cloth examples** collection (this guide plus Git, HTTP, regex, cron and SQL references) can be reloaded from the Knowledge page.

## Skills

A skill is a folder with a `SKILL.md` file: YAML front matter (`name`, `description`) and Markdown instructions. Extra files load on demand.

- **Add skills** imports from `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills` or any folder, or installs from the skills.sh registry. Skills with the same name from different sets install side by side.
- **Write one** drafts a skill with AI.
- **Tests** run eval cases against a model, graded by a judge model. **Baseline** reruns each case without the skill; **Freshness audit** looks for outdated advice.
- Verdicts: **fresh**, **stale** (below 80%, a 20-point drop, or a high-severity audit finding), **failing** (under 50%) and **redundant** (the model does as well without it).

## Tools

The **Tools** page lists the built-in tools (grouped, including the Cloth group for managing Cloth itself) and your custom tools.

- **HTTP** tools call an API; URL, headers and body are templates such as `https://api.example.com/items/{{id}}`.
- **JavaScript** tools run an async function body with `args`, `fetch` and `console`.
- **Command** tools run a program with one argument per line, with no shell, so values can't inject commands.
- **Prompt** tools call a model with a templated prompt.
- Every tool has a **Test** panel. A tool a chat makes with `tool_create` is reviewed by you before it can run code, then works everywhere.

## Web search

Pick an engine in **Settings › Web search**.

- **Obscura** is a headless browser that searches DuckDuckGo. It starts instantly and also renders pages for `web_fetch`.
- **SearXNG** queries several search engines at once. Cloth starts its bundled copy on first use, bound to 127.0.0.1, or you can point it at your own instance.
- `web_fetch` blocks localhost and private network addresses unless you allow them.
- Images from the web in replies wait for a click before they load.
- Downloads and searches trust your computer's certificates, so antivirus or company proxies don't break them.

## MCP servers

The **MCP servers** page connects Cloth to outside MCP servers and runs Cloth's own.

- **External servers** give chats and agents more tools. Add them by command or address; their secrets are stored encrypted. A server that is **On** is available in every chat and agent; a chat can still turn it off for itself, or narrow it to some tools, in Setup → MCP. **Off** means no chat gets it and it isn't started. Servers added anywhere (a chat, setup's import) show on the page at once.
- Servers at a web address that sign in through the browser (Datadog, Linear, Notion and others) need no token: when one asks, the server shows **Sign in**, which opens its sign-in page. Cloth keeps the sign-in and refreshes it; **Sign out** forgets it. For servers that need a client made by hand, add `"oauth": { "clientId": "…", "callbackPort": 8080 }` to its JSON.
- Configs can read environment variables as `${VAR}` or `${VAR:-default}`, as in Claude Code and Cursor.
- Changing **Ask me first** or **Run without asking** applies straight away without restarting the server.
- **Cloth's MCP server** at `http://127.0.0.1:7811/mcp` lets other apps use Cloth: `skill_list`, `skill_use`, `skill_create`, `rag_search`, `rag_collections`, `rag_index`, `tool_create` and `web_search`. An activity log shows each call.
- Claude Code: `claude mcp add --transport http cloth http://127.0.0.1:7811/mcp`. Cursor: add the URL under `mcpServers` in `~/.cursor/mcp.json`. Clients that only speak stdio can bridge with `npx mcp-remote <url>`.
- Turn on **Require bearer token** to demand `Authorization: Bearer <token>`.

## Dashboard

Usage for the last 24 hours, 7, 30 or 90 days, or all time: tokens, estimated cost, model calls and failures, response time, tool calls and skill uses, each compared with the previous period. Below: usage over time, which parts of Cloth use the most tokens, busiest hours, a per-model table, the most used tools and skills, automation success, skill health and recent activity.

## Phone

Settings › Phone pairs the Android app by QR code. Use Cloth from your phone on the same Wi-Fi, or anywhere with Tailscale. Only paired phones can connect, and they never see your saved secrets.

## Settings

- **Models:** which model does each job.
- **Chat:** chat titles, summarising long chats, and the background.
- **Coding rules:** rules every agent follows when it writes code, and ast-grep rule files.
- **Subagents:** how many run at once, their steps, the most they may do, and the model for review checks.
- **Web search**, **Knowledge** (chunking), **Swatches** (network sharing and port), **MCP server** (port and token) and **Phone**.
- **Design systems:** palettes, type and shape that projects follow; the Designer agent uses them.
- **Dependencies:** what Cloth ships (Obscura, SearXNG, OpenSpec) and what it uses from your computer (Git, GitHub CLI, Docker, Node.js, Python, Bash, PowerShell 7), each with its version and what happens without it.
- **Data & about:** the data folder, the version, updates, first-run setup again, and **Reset Cloth**, which deletes everything and restarts with defaults (optionally keeping downloaded models).
- **Ctrl+F** finds a setting. A setting you've changed has a blue outline and a Reset link.

Installed Windows builds update themselves from Cloth's releases; Settings shows when an update is ready.

## Keyboard shortcuts

On macOS use Cmd instead of Ctrl.

| Shortcut | Does |
|---|---|
| Ctrl+N | New chat |
| Ctrl+K | Search chats |
| Ctrl+B | Hide or show the chat list |
| Ctrl+E | Archive the open chat |
| Ctrl+. | Hide or show the side panel |
| Ctrl+` | Open the terminal |
| Ctrl+F | Find a setting (on Settings) |
| / | Invoke a skill (in the composer) |
| @ | Hand the message to an agent (in the composer) |
