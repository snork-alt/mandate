# Mandate

A local specification system for coding agents: specs, standards, work orders and feedback in git, served to your
coding agents over MCP, with a web UI.

```sh
npx getmandate install     # sets Mandate up on this machine, starts it in the background, opens it
cd ~/code/my-app
mandate connect            # links this repo to a Mandate project for your coding agents
```

Requires Node.js 22+. Works with Claude Code, Codex, Cursor, VS Code (Copilot), Gemini CLI, Windsurf / Devin Desktop and opencode.

On a server (teammates sign in with GitHub): `npx getmandate install --mode server --public-url https://mandate.example.com`.

Other commands: `mandate open | status | start | stop | restart | logs -f | doctor | update | uninstall [--purge]`.
