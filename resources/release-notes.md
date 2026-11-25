## New in 1.5.1
- The 1.5.0 installers failed to build, so 1.5.1 is the first 1.5 release you can install. Everything below is new since 1.4.
- The page sidebar folds to a column of icons on every page: press Ctrl+B, or point at the sidebar and click the round arrow on its right edge. Cloth remembers your choice. Hiding the chat list is now Ctrl+Shift+B.
- The Cloth logo now sits in the middle of the strip along the top of the window.
- Fix: on macOS, the agent no longer refuses files in a workspace under `/var` (such as temp folders) as "outside the workspace".

## Mockups
- Ask a chat to mock something up and it publishes a mockup: a set of screens (boards) at desktop or phone size, made to look like the real product. Each change is a new version on the same link, and the last 20 are kept.
- The chat checks its own boards before finishing: it looks at each one as a picture and fixes clipped text, overlaps and broken layout.
- Open a mockup to see every board on a canvas with zoom and a version picker. **Play** opens a board full size with its controls working, at desktop or phone width.
- Boards can have **Tweaks**: switches for a state, a count, a toggle or an accent colour, so you can see each variant without asking for it.
- A bar under the canvas asks the chat for a change to the board on screen. Export saves boards as PNGs.
- A chat in a project with a design system uses its colours and components on every board.
- A mockup's link opened in a browser or on another device shows all its boards.

## Swatches
- The Swatches page is now a library: cards with a real preview of each swatch, filters by kind with counts, search and sorting.
- A swatch opens beside its live preview, with its links, QR code, rename, delete, a new link and Save as. The preview fills the screen's height.

## Chats
- A turn that works through a todo list shows one run card: a row per step with its changes, failures and time, and the work done for each step under it. While it runs it shows the current action and progress; when done it folds into one line.
- After summarising in the middle of a long turn, the chat carries on by itself instead of stopping cut off and waiting for you to say "continue".
- The side panel no longer has a title bar on a wide screen: the dock beside it shows which panel is open and closes it (or press Ctrl+.).
- Replies show their speed in tokens per second, and the context panel can strip tool calls.
- Context size and cost now show for any model, whatever the provider (OpenRouter, proxies, Z.ai and others).

## Code
- Agents run the project's formatter and linter before finishing. Settings → Chat chooses when they run, whether they fix, and what happens in folders with no setup; Prettier ships with Cloth, and Ruff, Biome, golangci-lint and google-java-format install on demand.
- Java support through jdtls. Settings → Languages installs, updates and removes Cloth's own gopls, rust-analyzer, clangd and jdtls.
- Shell commands can run in the background, with tools to read their output and stop them. On Windows, Git Bash is available beside PowerShell, and the working directory carries over between commands.
- Agents take fewer steps: `read` numbers its lines and reads up to 10 files at once.
- Spec → Ship keeps your whole request and every answer when it hands over, so specs keep your exact names and texts. Its review sticks to problems a real caller can hit, and workers can read the project's dependencies.
- OpenSpec and Spec → Ship commit to a local branch and open a pull request only when asked.

## MCP servers
- Each server has one On/Off switch: an On server is in every chat, agent and automation, and a chat can still turn one off for itself.
- Servers imported in setup start at once, and their tools ask before running.

## Boards and automations
- Edit a project: rename it, delete it, pick the agent for each step and its code folder.
- Builds work in folders without git: the work happens in a copy and Apply copies the changes back.
- An automation can run in no folder, a folder on this PC, or a container folder kept between runs.

## Fixes
- Opening a chat from the phone no longer closes Cloth on the desktop.
- Cloth's window shows sooner at startup, and a slow start shows a small window saying what is starting.
- `find` looks inside an ignored folder such as `node_modules/<package>` when pointed at it.
