<p align="center">
  <img src="packages/web/public/logo.svg" width="80" alt="Mandate logo" />
</p>

<h1 align="center">Mandate</h1>

<p align="center">
  <b>Specs your coding agents read, write and keep in sync with the code.</b><br/>
  A git-backed, MCP-native spec system for teams that run many coding agents at once, with a read-only web UI for humans.
</p>

<p align="center">
  <img alt="License: FSL-1.1-ALv2" src="https://img.shields.io/badge/license-FSL--1.1--ALv2-blue" />
  <img alt="Node.js 22+" src="https://img.shields.io/badge/node-%E2%89%A522-5FA04E?logo=nodedotjs&logoColor=white" />
  <img alt="MCP native" src="https://img.shields.io/badge/MCP-native-8B5CF6" />
  <img alt="Storage: git" src="https://img.shields.io/badge/storage-git-F05032?logo=git&logoColor=white" />
  <img alt="Sign in with GitHub" src="https://img.shields.io/badge/sign--in-GitHub-181717?logo=github&logoColor=white" />
  <img alt="SQLite or Postgres" src="https://img.shields.io/badge/state-SQLite%20%7C%20Postgres-336791" />
</p>

<p align="center">
  <img src="docs/media/live.gif" alt="Claude Code receives a task in the terminal; behind it, the Mandate web UI shows the work order, the code and the spec changing as the agent works" />
  <br/><sub>A coding agent picks up a task; Mandate tracks the work order, code and spec as it happens. (A real Claude Code run against a demo project, sped up; the terminal replays the run's actual tool calls, lightly trimmed.)</sub>
</p>

---

## The problem

**Many agents, no shared picture.** When five coding agents work in parallel (yours, your teammates', CI), nobody can
say what is being built right now, by whom, against which version of the requirements, or what is waiting on a human.

**Specs drift.** You iterate fast: *"actually, make it 7 days"*, *"also handle Microsoft accounts"*. Each instruction lands
in one agent's chat, the code changes, and the spec doesn't. A week later the spec, the tests and the code describe three
different products, and the next agent works from the wrong one.

## How Mandate solves it

Mandate gives specs a single home that agents treat as the source of truth, and makes them keep it current as part of the
work.

- **One place for intent.** Specs, standards and components are Markdown in a git repository. Coding agents read and write
  them over MCP (the only interface), so every agent works from the same, current version.
- **Change goes through the spec.** The Mandate skill turns *"add remember-me to login"* into a spec change, a work order
  and a verified delivery, so code and spec move together.
- **Drift is detected, not discovered.** Acceptance criteria carry verifications. When a criterion changes after it
  passed, or a done spec no longer meets its done gate, Mandate flags it.
- **Humans see everything and decide what matters.** A calm, read-only UI shows maturity, live agent activity, lineage and
  the decisions waiting for you.

```mermaid
flowchart LR
  subgraph Agents["Coding agents (Claude Code, Codex, Cursor, …)"]
    A1["agent 1"]
    A2["agent 2"]
    A3["CI review agent"]
  end
  A1 & A2 & A3 -->|"MCP · signed in as you"| S["Mandate server"]
  H["You, in the web UI<br/>(read-only + decisions)"] -->|"GitHub sign-in"| S
  S -->|"every write is a commit"| G[("Project repo<br/>Markdown + JSONL")]
  S --> I[("Index<br/>full text · embeddings · graph")]
  G <-->|"background push / pull"| GH["GitHub"]
  S -.->|"questions, drift, findings"| H
```

## A tour

### Architecture at a glance

<img src="docs/media/architecture.gif" alt="The layered architecture diagram: panning through UI, API, service, domain, data and infra layers, focusing on a component's links, then opening the component page" />

Components declare the code they own (globs), their layer, their dependencies and the components they contain. Mandate
draws a layered, top-to-bottom diagram (UI → API → services → domain → data → infra) with nested components, flags
dependencies that point *up* a layer, and lets you pan, zoom, collapse groups, focus on a component's upstream and
downstream links, and compare against an earlier commit. Each component page lists its interfaces, the specs that affect
it, the standards it follows and the code it owns.

### Overview: what needs you

<img src="docs/media/overview.gif" alt="The Mandate overview: spec maturity across the project, what needs attention, and questions from coding agents waiting for a decision" />

The Overview answers "how far along are we, and what is waiting on me?". The maturity bar shows every spec on the ladder
*Draft → Specified → In progress → Implemented → Verified → Audited*, with overlays for **failing**, **drifted**,
**blocked** and **stale**. **Action needed** collects every human decision in one list: open questions from agents,
legacy waivers, draft standards, stale claims, drifted done specs, contradicted audits and integrity issues. **In progress**
shows claimed work orders with their branches and heartbeats; **Health** shows verification and audit coverage.

Agents ask you questions **asynchronously** (`question_ask`): they keep working on what doesn't depend on the answer, and
you answer in the UI when you get to it. An answered question becomes the recorded proof for the write it decides, for
example a change to a standard.

### Specs, maturity and drift

<img src="docs/media/specs.gif" alt="The spec list with maturity badges, then a drifted spec with its sections, criteria and history" />

A spec is a list of typed sections: Markdown, Mermaid diagrams, HTML mockups, acceptance criteria and rules. Sections link
to other sections, to standards, to components and to exact code (`repo:path#L10-40`, symbols). The rail shows history
with Word-style tracked changes from git, properties, dependencies and the standards in force.

- **Maturity badges** are derived, not hand-set: from implemented sections, verified criteria and audits.
- **Drift:** a done spec that no longer satisfies its done gate (criteria added, changed or unverified since) is marked
  *Drifted*, with the exact criteria and why. Sections whose dependencies changed show *Upstream changed*.
- **Standards** hold rules with *must / should / may* levels, Do/Don't examples and scopes. They are never changed without
  your explicit confirmation.
- Anything can be copied as a reference, e.g. `@mandate:mandate://specs/rate-limiting/sections/limits`. Paste it into
  your coding agent and it resolves to exactly that section, at the current or a pinned version.

### Work orders

<img src="docs/media/work-orders.gif" alt="Work orders by status, then a delivered work order with its plan, sections, touched code, comments and git context" />

A work order hands specific **sections** to an agent, pinned to a commit. Agents pick one atomically
(`work_order_next`), **claim** it on a **branch** (and worktree) and keep the claim alive with heartbeats. As they go they
mark sections done, record the **code they touched**, notes and deviations, and a verification for each acceptance
criterion. Reviewers (people or agents) leave blocking or non-blocking comments. Completion goes through the done gate,
and the agent reconciles the spec and components with what was actually built.

### Audits and lineage

<img src="docs/media/lineage.gif" alt="An audit with failing findings, then its lineage: findings, the fix work order and the request it produced, and the story timeline" />

An **audit** checks a spec (or a standard) against the code, item by item, with evidence. Findings that are code deviations
become **fix work orders** (`audit_findings_to_work_orders`); findings that show the spec itself is ambiguous become
requests on the spec.

**Lineage** answers "why does this exist?" and "what did it lead to?" for any element: specs, sections, standards,
components, work orders, requests, audits and findings, verifications, commits, PRs and code. Every MCP write accepts a
`cause`, recorded in commit trailers and a `caused_by` graph edge, so the chain is captured at write time, not
reconstructed later. The Lineage page draws it as a graph (causes above, effects below) or as a timeline, with time travel
to any commit or date. Before a change, `blast_radius` lists what it would hit: dependent specs, followers of a standard,
owned code and open work orders on the same files.

### Ask

<img src="docs/media/ask.gif" alt="Asking which specs have drifted and why; the model calls Mandate's read tools and answers with clickable references" />

The **Ask** panel answers questions about the project with the model of your choice (Anthropic, OpenAI, Google or any
OpenAI-compatible endpoint, including a local Ollama). It uses the same read-only MCP tools as agents, including the
spec graph and a Cypher subset, shows each tool step, and answers with clickable references, tables and graphs. *(The
recording above is a real answer from a configured model, with the wait sped up.)*

### Who did what

Every write records the coding agent **and** the GitHub user it acted for (`Mandate-User:` and `Agent:` commit trailers).
Pages show "Created by Alice via claude-code", contributor avatars per document and section, and the activity feed can be
filtered by user and agent. Commits made for a signed-in person are authored by that person.

### Search everything

<kbd>⌘K</kbd> searches full text, meaning (embeddings), symbols, code paths and IDs together. Agents get the same search over
MCP, plus a temporal **knowledge graph** they can traverse or query with Cypher: *"what breaks if this standard changes?"*,
*"which specs touch `src/auth/session.ts`?"*, *"what did this look like last Tuesday?"*.

## Quick start

Requirements: Node.js 22+ (and git, to push your projects). No compiler needed: native modules ship prebuilt.

### 1. Install the server

```sh
npx getmandate install
npx getmandate install --public-url https://mandate.example.com   # behind your HTTPS reverse proxy
```

The installer installs the `mandate` command, starts Mandate in the background (launchd on macOS, systemd `--user` on
Linux), adds the Mandate skills and slash commands to the coding agents it finds, and opens the setup wizard. For a public
address it listens behind your reverse proxy, prints ready-to-use Caddy and nginx configs tuned for MCP's streaming
responses, and prints the one-time setup link with an SSH tunnel to reach it safely.

Many browser tabs: over plain HTTP/1.1 a browser opens at most 6 connections per origin, so the web UI shares a single
live-update stream across all tabs of the same browser (one tab holds it and relays to the others). Behind the
generated Caddy or nginx config (HTTPS with HTTP/2) this limit disappears altogether.

Useful flags: `--port N`, `--bind ADDR`, `--no-service`, `--no-open`, `--no-agents`, `--agents a,b`, `--dry-run`, `--yes`.

### 2. Run the setup wizard

<img src="docs/media/setup-wizard.gif" alt="The six-step setup wizard: GitHub App, Git, Ask models, Semantic search, Database, Sign in" />

1. **GitHub App.** Mandate creates one in one click, on your account or an organization: you review it on GitHub and press
   *Create GitHub App*, and GitHub hands the credentials back. The client secret, webhook secret and private key go to
   `~/.mandate/secrets.env` and a 0600 key file, never `config.json`. An existing OAuth App also works.
2. **Git.** System git or the built-in one, and whether to push to GitHub automatically.
3. **Ask models** *(optional)*. Add as many as you like.
4. **Semantic search** *(optional)*. Ollama, OpenAI, an OpenAI-compatible URL, or keyword search only.
5. **Database** *(optional)*. SQLite (built in) or Postgres.
6. **Sign in** with GitHub. You become the admin.

Everything can be changed later in Settings.

### 3. Create a project

A project is a GitHub repository (or a folder in one) that holds its specs. **New project** in the UI lists the
repositories the GitHub App is installed on, personal or from an organization, with a link to install it on more. Each
project has its own index, activity feed, Ask history and MCP endpoint (`<server>/p/<project>/mcp`).

### 4. Connect your coding agents

On each developer machine, one line installs the Mandate CLI (`getmandate`) and wires every coding agent it finds to a
project: the MCP server entry, the Mandate skills and the slash commands. The **Connect agent** dialog shows it with a
copy button:

```sh
curl -fsSL https://mandate.example.com/p/<project>/install.sh | sh
# flags go to `getmandate connect`:  … | sh -s -- --agents claude-code,codex --dry-run
# remove the wiring again:           … | sh -s -- --uninstall
# remove the wiring AND the CLI:     curl -fsSL https://mandate.example.com/uninstall.sh | sh   (--dry-run, --purge)
```

On Windows PowerShell: `irm https://mandate.example.com/p/<project>/install.ps1 | iex` (uninstall:
`irm https://mandate.example.com/uninstall.ps1 | iex`). On the machine running Mandate, `mandate connect` in a code
repository does the same.

- The CLI comes from the Mandate server itself, at the server's exact version (`<server>/getmandate.tgz`, checked
  against its SHA-256, which is embedded in the script; npm is never asked for `getmandate`). It is installed with
  `npm install -g`; without write access to npm's global folder it goes to `~/.mandate/cli` and the script prints the
  `PATH` line to add (it never edits your shell files). Running the line again installs the server's CLI build
  whenever it differs from the installed one (the tarball's SHA-256, recorded in `~/.mandate/cli-build`, not just the
  version; `--reinstall` forces it), then runs `getmandate connect`.
- The skills and slash commands it writes are short stubs: the coding agent loads the current instructions from the
  server (`instructions_get`), so a server update reaches every agent without reinstalling.
- The script holds no token and pins the server's exact Mandate version.
- Agents sign in with GitHub on first use (MCP OAuth, with PKCE and short-lived, project-bound tokens), so nothing secret
  is written. Agents that can't sign in by themselves use a personal token (`--auth token`), kept only in
  `~/.mandate/env.sh` (0600).
- Inside a git repo it asks before adding the repo's MCP entry and the `CLAUDE.md` / `AGENTS.md` section (`--yes` to
  accept), and ends with a per-agent summary.
- To read the script before running it, compare the published checksum:
  `curl -fsSLO …/install.sh && curl -fsSL …/install.sh.sha256 | shasum -a 256 -c - && sh install.sh`.

**Supported agents.** Paths and formats come from each agent's official docs; capabilities that couldn't be verified are
written only with `--force`.

| Agent | MCP | Skills | Slash commands | Instructions file |
|---|---|---|---|---|
| Claude Code | ✓ | ✓ `~/.claude/skills` | ✓ `.claude/commands` | `CLAUDE.md` |
| Codex | ✓ | ✓ `~/.agents/skills` | ✓ `~/.codex/prompts` | `AGENTS.md` |
| Cursor | ✓ | ✓ `~/.agents/skills` | ✓ `.cursor/commands` | `AGENTS.md` |
| VS Code (Copilot) | ✓ | ✓ `~/.agents/skills`, `~/.copilot/skills` | ✓ `.github/prompts` | `AGENTS.md` |
| Gemini CLI | ✓ | ✓ `~/.agents/skills` | ✓ `.gemini/commands` (TOML) | `GEMINI.md` |
| Windsurf / Devin Desktop | ✓ | ✓ `~/.agents/skills` | MCP prompts | `AGENTS.md` |
| opencode | ✓ | ✓ `~/.agents/skills` | ✓ `.opencode/commands` | `AGENTS.md` |
| JetBrains Junie | ✓ user scope | ✓ `~/.agents/skills` | unverified | `AGENTS.md` |
| Amp | ✓ | ✓ `~/.agents/skills` | skills | `AGENTS.md` |
| Goose | manual (YAML snippet printed) | ✓ `~/.agents/skills` | – | `AGENTS.md` |
| Cline | ✓ user scope | ✓ `~/.cline/skills` | MCP prompts | `AGENTS.md` |
| Zed | unverified | ✓ `~/.agents/skills` | – | `AGENTS.md` |

`mandate agents` shows what was detected on your machine and what is installed.

**Who sees what.** Access follows GitHub, per project: if you can read a project's repo, you see the project and your
agents can use the read tools; if you can push, they can also write (org and team grants count, checked with your own
GitHub token and cached for 5 minutes). Without access the project doesn't exist for you (404). `allowedUsers` /
`allowedOrgs` optionally restrict who may sign in; people in `allowedUsers` are the admins. CI uses named service
accounts (`mandate key create <project> --service <name>`).

### 5. Work as usual

Ask your agent for what you want, e.g. *"add remember-me to login"*. One **master skill** (installed for every agent; the
MCP server's instructions carry the same rules for agents without it) runs the flow:

- **Request.** Every instruction you give is recorded as a **request** (it needs no approval from you). `spec_match` finds
  where it fits (already covered, extend a section, a new section or spec, or a cross-cutting rule for a standard). The
  agent updates the spec (an acceptance criterion for every changed section) and the standards, then opens a **work order
  that carries the full plan**: steps, files to change, the tests it will write (each mapped to the acceptance criteria it
  proves) and risks. Only questions the agent raises itself (`question_ask`: standards, waivers, doubts) wait for your
  answer, and it keeps working on whatever does not depend on it.
- **Delivery.** The agent claims the work order, marks sections done as they land (the code it touched is copied onto the
  spec section, which then reads "Implemented by" that work order), and records a passing verification per criterion that
  names its test (the spec then reads "Proved by" that test). `work_order_complete` refuses until every acceptance
  criterion the work order covers has a test-linked pass; completing it closes the request. If the spec is unclear, the
  agent asks you instead of guessing.
- **`/mandate-flow on|off|status`** (and `questions mandate|chat`) turns the flow on or off for your agent client, within
  the project policy an admin sets in Settings → Agent flow (*required*, *optional* or *off*). Only the agent changes it
  (Settings shows it read-only). With the flow off, the server refuses that agent's write tools (`flow_off`) and Mandate
  is read-only context; the agent saves the returned instructions to its memory.
- **`/mandate-bootstrap`** reverse-engineers an existing codebase into Mandate in three stages, each by a fresh agent:
  **extract** typed notes (kept in `~/.mandate/bootstrap/`, never in the repo), **distill** them into components, standards
  and specs (with your confirmation for every standard), and **review** the result against the code. Everything it writes
  is marked *Inferred* until you confirm it; `--resume` continues a run.

## Commands

| | |
|---|---|
| `mandate open` | Open Mandate: the setup wizard while setup is pending, else the UI |
| `mandate connect [--project id] [--url server] [--agents a,b] [--remove]` | Link the current repo to a project for your coding agents |
| `mandate status` · `doctor` | State, URL, version, projects and setup; diagnostics with fixes |
| `mandate start` · `stop` · `restart` · `logs -f` | Control the background service (`start --foreground` runs it in the terminal) |
| `mandate update` | Install the latest version and restart |
| `mandate uninstall [--purge]` | Remove the service and all agent wiring; keeps `~/.mandate` unless `--purge` |
| `mandate key create <project> --service <name>` · `key list` · `key revoke <id>` | Service-account keys for CI |
| `mandate agents` | Coding agents found on this machine: what each supports, and what is installed |
| `mandate bootstrap init · status · validate · clean` | Run folders for `/mandate-bootstrap` |

`install`, `connect` and `uninstall` are idempotent, take `--dry-run` and `--yes`, act on the detected agents by default
(`--agents a,b` to choose, `--all` for every agent), and mark every file they write as managed by Mandate.

## Configuration

Everything lives in `~/.mandate/`. Secrets are only ever referenced by environment-variable name.

| File | What it holds |
|---|---|
| `config.json` | Address (`server.publicUrl` / `bind`), GitHub sign-in, Ask models, embeddings, git backend, auto-push. Edited by the wizard / Settings or by hand |
| `secrets.env` | API keys and the GitHub client secret (`KEY=value`, mode 0600, never logged) |
| `projects.json` | The project registry, managed by Mandate |
| `keys.json` | Service-account keys for CI (mode 0600) |
| `state.sqlite` | Server state: sessions, encrypted GitHub tokens, personal / OAuth tokens (or Postgres, below) |
| `env.sh` | Personal tokens for `connect --auth token` (mode 0600) |
| `logs/server.log` | The background service's log (`mandate logs -f`) |

Saved settings apply without a restart, including the git backend and the database; changing the address restarts the
service.

**Ask models.** Configure several and pick one per question:

```json
"ask": {
  "default": "opus",
  "models": [
    { "id": "opus", "label": "Opus 5.5", "provider": "anthropic", "model": "claude-opus-5-5", "apiKeyEnv": "ANTHROPIC_API_KEY" },
    { "id": "local", "label": "Llama (local)", "provider": "openai-compatible", "model": "llama3.1", "baseUrl": "http://localhost:11434/v1" }
  ]
}
```

Optional limits under `ask` (and per model): `maxToolCalls` (12), `tokenBudget` (150,000 tokens per question) and
`maxToolResultTokens` (5,000, per tool via `toolResultTokens`).

**Postgres.** Server state lives in SQLite by default. To share it between several server instances, put the URL in
`~/.mandate/secrets.env` and select it (Settings → Database, or by hand):

```json
"database": { "driver": "postgres", "urlEnv": "MANDATE_DATABASE_URL", "ssl": "require", "pool": { "max": 10 } }
```

Mandate creates a `mandate_server` schema and one `mandate_<project>` schema per project, where the search index (full
text, trigram, pgvector HNSW and the temporal graph) is published after every sync. It needs PostgreSQL 14+ with `vector`
and `pg_trgm`; **Test connection** in Settings checks all of it. `npm run mandate -- db copy` moves sessions and tokens from
SQLite. Your specs stay in git. On Supabase, use the direct connection or the session pooler (port 5432) with
`?sslmode=require`.

**Git push credentials.** With a GitHub App configured, Mandate pushes over HTTPS with short-lived installation tokens kept
in memory only, so no SSH key is needed. `git.auth.method: "ssh"` uses `sshKeyPath` or the ssh-agent instead, and the
`cli` backend can keep using your own git credentials.

## Architecture

- **Git is the database.** Every write is a commit with `Agent:`, `Mandate-User:`, `Request:` and `Work-Order:` trailers. Mandate pushes
  in the background and never force-pushes.
- **MCP is the only interface**, for agents and for the web UI, which is itself an MCP client. The UI session is
  read-only except for human decisions (answering questions, rejecting requests, releasing stale claims), which
  go through the same write tools with the same gates and are attributed to you.
- **The request flow by default.** Agents see the ~47 `core` tools: project info, `search` / `get` / `list`, the request
  tools (`request_create` ...), `spec_match`, the document edits (`create`, `section_insert`, links), the work-order
  steps, verification, questions, `status_set`. `tools_enable { sets }` adds `bootstrap`, `review`, `lineage` or `admin`
  (the server sends `tools/list_changed`); clients that don't refresh their list can use `…/p/<project>/mcp?tools=core,review`
  or `?tools=all`. Any tool can be called by name even when it is not listed,
  and the older names (`spec_get`, `spec_status_set`, `feedback_create` ...) still work. Requests were called feedback
  before: `mandate://feedback/<id>` refs, `of: "feedback"`, `Feedback:` commit trailers and `feedback.jsonl` are still read.
- **Strict by design.** Every call is validated: status transitions, the done gate on acceptance criteria, claim
  conflicts, link direction rules, append-only verifications. Errors carry codes an agent can act on.
- **Indexes stay current.** Full-text, symbol and graph indexes update on every commit; embeddings are computed in the
  background through a durable job queue.

| Package | |
|---|---|
| `packages/doc` | The document format: sectioned Markdown with frontmatter, pluggable section types, byte-stable round trips |
| `packages/shared` | Types, zod schemas and `mandate://` references shared by server and UI |
| `packages/server` | Fastify + MCP server, git storage (embedded libgit2 or the git CLI), SQLite / Postgres index, Cypher compiler, Ask agent |
| `packages/web` | React + Mantine UI, itself an MCP client |
| `packages/cli` | The `getmandate` npm package: the `mandate` command (also installed as `getmandate`), service, agent wiring; bundles the server and the built UI |

## Development

```sh
git clone https://github.com/snork-alt/mandate.git
cd mandate
npm install
npm run dev          # API on :4000, web UI with hot reload on :5173
npm run seed         # optional: a sample project with specs, standards, components and work orders
```

In dev, the installer download (`/getmandate.tgz`) is built on demand from the sources and rebuilt when they change
(`MANDATE_CLI_AUTOBUILD=0` turns this off).

```sh
npm run typecheck
npm test             # vitest across all workspaces
npm run build        # server + web dist + the publishable CLI (packages/cli/dist)
npm start            # production mode: one port, the server serves the built UI
npm run smoke        # npm pack → npx <tarball> install in a temp HOME → start → /health → UI
```

## License

Mandate is licensed under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE.md) (FSL-1.1-ALv2).

- **You can:** use, self-host and modify Mandate for your own team or company, use it for education and research, and contribute back.
- **You can't:** offer Mandate, or something substantially similar built from it, as a competing commercial product or hosted service.
- **It becomes Apache-2.0:** each release converts to the Apache License 2.0 two years after it is published.

Copyright 2026 Matteo Pelati.
