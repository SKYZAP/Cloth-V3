## MCP servers
- Servers that sign in through the browser (Datadog, Linear, Notion and others) now work without a token: the server shows **Sign in**, which opens its sign-in page. Cloth keeps the sign-in and renews it, and **Sign out** forgets it.
- A chat starting such a server in the background never opens your browser; the MCP page says it needs a sign-in.
- Server configs can read environment variables as `${VAR}` or `${VAR:-default}`, and take an `oauth` block (`clientId`, `callbackPort`) for servers that need a client set up by hand. Servers imported from Claude Code and Cursor keep working.
- When a server changes its tools while running, Cloth picks up the new list.
- Switching between Ask me first and Run without asking, or turning a server on for new chats, applies right away instead of restarting the server.
- Cloth's own MCP server works again with Claude Code and other apps on PCs whose security software rewrites local MCP traffic.

## Chats
- New chats start on the model you picked last, with the reasoning effort you last used for that model, and in Auto or Manual as you last set it.
- Switching a chat back to a model brings back the effort you used with it.

## Fixes
- The setup window scrolls again: the Import step no longer cuts off a source's list when you open Review.
