# Cloth

**Your AI workbench on the desktop.** Chat with any model, give it your own documents, build reusable skills,
automate tasks with visual flows — all stored locally on your computer.

Works with OpenAI, Anthropic, OpenRouter, LiteLLM, and local models through LM Studio, Ollama, llama.cpp or vLLM.

## Download

Grab the latest installer from the [Releases page](https://github.com/SKYZAP/Cloth-V3/releases):

- **Windows** — `Cloth-Setup-<version>.exe`
- **macOS (Apple silicon)** — `Cloth-<version>-mac-arm64.dmg`

Then open **Models**, add a provider (an API key, or the address of your local model server), and start chatting.

## What you can do

- **Chat** — talk to any model, switch models mid-conversation, and see every step the AI takes. Chats get short
  AI-written titles so they're easy to find later.
- **Work on your files** — point a chat at a folder and the AI can read, search and edit files and run commands.
  You approve changes first, and can undo any step.
- **Use your own knowledge** — add files, folders, PDFs, Word documents, web pages or notes. The AI searches them and
  cites its sources.
- **Search the web** — built-in web search and page reading, no extra setup.
- **Generate images** — with any image model your provider offers.
- **Skills** — save instructions the AI can reuse, write them yourself or have AI draft them, and test that they
  still work over time. Import skills from other tools, or install yours into them.
- **Flows** — build automations on a visual canvas, or describe what you want and let AI build it. Run them on a
  schedule, track every change (and roll back), and fix a failed run with one click.
- **Export a flow as an app** — package a flow into its own Windows installer to share with someone else.
- **Custom tools** — give the AI new abilities: call a web API, run a script or command, or reuse a prompt.
- **Dashboard** — see token use, estimated cost, speed, and which tools and flows succeed.
- **Connect other apps (MCP)** — let other AI tools use your skills, knowledge and web search.
- **Phone app (Android)** — pair by scanning a QR code and use Cloth from your phone on the same Wi-Fi (or anywhere
  with Tailscale).

## Your data

Everything — chats, documents, skills, flows — stays on your computer, in `%APPDATA%\Cloth` on Windows or
`~/Library/Application Support/Cloth` on macOS. API keys are encrypted with your system keychain. The only things that
leave your machine are requests to the model providers and websites you choose to use.

## Good to know

- The MCP server listens only on your own computer (`http://127.0.0.1:7811/mcp`) and can be protected with a token.
- Scripts in flows and custom tools run with the same access as Cloth itself — only run code you trust.
- The installer is fairly large (~230 MB extra) because it includes its own web browser and search engine.

---

## For developers

```bash
npm install
npm run dev          # run the app with hot reload
npm test             # run the tests
npm run typecheck
```

Other useful commands:

| Command | What it does |
|---|---|
| `npm run mock-llm` | Starts a fake OpenAI-compatible model on `http://127.0.0.1:5055/v1` for testing without a real model |
| `npm run smoke` | Builds the app and clicks through it automatically, saving screenshots to `.cloth-dev/smoke` |
| `npm run sidecars` | Downloads the bundled web browser (Obscura) and search engine (SearXNG) |
| `npm run package` | Builds an unpacked app in `release/` |
| `npm run dist` | Builds the installers |
| `npm run mobile:apk` | Builds the Android app |

Built with Electron, React, Tailwind and Node's built-in SQLite; the AI agent runs on
[`pi-agent-core`](docs/adr-0001-agent-runtime.md). The development build keeps its data separately, in `Cloth-dev`.

### Releasing

Publish a GitHub release with a tag like `v1.2.0`, or run the **Release** workflow manually with a version number.
It runs the tests, then builds and attaches the Windows and macOS installers. Builds are unsigned unless signing
secrets are set (see the top of `.github/workflows/release.yml`).

The website in `website/` is published to GitHub Pages by `.github/workflows/pages.yml` whenever it changes on master.

## Contributing

Issues and pull requests are welcome.

1. Fork the repository and make a branch from `master`.
2. `npm install`, then `npm run dev` to run Cloth with hot reload. It keeps its data apart from an installed Cloth.
3. Before opening a pull request, run `npm run typecheck` and `npm test`. The **Tests** workflow runs both on every
   pull request.
4. Keep pull requests focused on one change, and say in the description what it changes and how you checked it.

Never commit API keys, tokens or `.env` files. Cloth stores keys encrypted on each user's computer, and tests use fake
values.

## License

[MIT](LICENSE)
