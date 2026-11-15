## Boards
- A new Boards page drives tracker tickets through agent stages: a planner writes requirements, a reviewer checks them against the goal, and an implementer builds in its own worktree and opens a PR.
- Works with Plane, Jira, or a Cloth board kept offline in Cloth's own storage, with no account or token.
- Per-project settings for what agents may do: commit or not, open PRs, sync tickets back to the tracker, approve requirements first, and how many review rounds and check fixes to try.
- When a PR fails its checks, the implementer reads the CI logs, fixes the cause and pushes to the same PR.
- The planner researches what a ticket depends on, and each feature lands as one conventional commit with a standard PR title and description.
- Open in chat starts a chat for a ticket with its requirements and PR ready in the message box.

## Swatches
- Chats can publish swatches: pages, documents and images the agent makes, shown live right in the conversation.
- Open a swatch in the new Swatches tab of the side panel, or on the Swatches page; close it there and pick another from the chat's list.
- Each swatch has a private link, and can be shared with phones and computers on your network.

## Chat
- Chat has its own canvas: the chat list on the frame, and a side panel card opened from a dock that shows running terminals, git changes, agents and builds.
- Animated chat backgrounds in five styles (flow, waves, mesh, swirl and halftone) with adjustable strength; ask a chat to make or adjust a theme.
- Chats are archived instead of deleted, with Undo and Ctrl+E.
- File paths in replies open in the side panel's file viewer.
- OpenSpec mode takes a change from proposal to pull request; OpenSpec and Spec → Ship share one Spec tab with a mode toggle.
- Agents have one access level (Reader, Writer, Operator) and one reasoning level (Low to Max), and the chat agent can set up agents, automations, MCP servers and model providers for you.

## Setup and settings
- A first-run setup picks your model, working folder, languages and tools, and imports skills, agents and MCP servers from Claude Code, Claude Desktop, Cursor and Codex.
- Settings › Dependencies shows what Cloth ships and what it uses from your computer.
- Reset Cloth starts over from scratch, optionally keeping downloaded models.
- Changed settings are marked with a blue outline, and Models and Settings use the full window width.

## Security and fixes
- MCP and provider tokens are stored encrypted and never shown in the app or on paired phones.
- Images from the web in replies wait for a click before loading.
- The OpenSpec command-line tool now ships with Cloth, so it works without a separate install.
- Web search no longer fails to start when another tool sets a key-log file.
- Updated the agent runtime and patched dependencies; npm audit reports no vulnerabilities.
