# Suvadu

> *Suvadu* (சுவடு) — Tamil for **footprints**.

Every commit, every PR, every review comment, every Jira ticket is a footprint — a trace of a decision someone made as they walked through your codebase. Suvadu collects those footprints so AI coding agents can follow the trail, not just read the current state of the ground.

---

## The problem

AI coding agents can read your code but they walk blind through its history. They don't know why a parameter exists, which PR introduced a flow, what a reviewer warned about, or what business decision drove a change. Every session starts from zero.

## What it does

Suvadu indexes your repositories locally — reading commits, PRs, review comments, and Jira tickets — and surfaces the relevant footprints to your agent before it edits or reviews code.

- **Local-first** — nothing leaves your machine unless you configure GitHub/Jira API calls
- **No embeddings** — structured indexed data, not vector search
- **MCP server** — works with Claude Code, Cursor, Windsurf, Zed, and any MCP client
- **SQLite storage** — a single `.suvadu/suvadu.sqlite` file per workspace

## Requirements

- **Node.js ≥ 22.13.0** — required (uses `node:sqlite`, available from Node 22+)
- **Git** — required for indexing commits and file history

## Install

```bash
npm install -g suvadu
```

Or run without installing:

```bash
npx suvadu --help
```

## Quick start

### Using the dashboard (recommended)

```bash
cd ~/my-repos     # the folder containing your repositories
suvadu init       # initialize a workspace here
suvadu ui         # open the dashboard at http://localhost:7337
```

The dashboard walks you through everything:
- Add repositories via the folder navigator
- Configure GitHub and Jira credentials in Settings
- Index repos and monitor their status
- Connect Claude Code (or any MCP client) with one click

### Using the CLI

```bash
cd ~/my-repos
suvadu init
suvadu repo add ./my-service
suvadu repo index my-service
suvadu serve      # start the MCP server for agents
```

## MCP client setup

### Claude Code

Use `suvadu ui` → **Connect Claude Code** to configure this automatically.

Or manually:

```bash
claude mcp add suvadu --command suvadu --args serve --cwd /path/to/your/workspace
```

### Other clients (Cursor, Windsurf, Zed)

```json
{
  "mcpServers": {
    "suvadu": {
      "command": "suvadu",
      "args": ["serve"],
      "cwd": "/path/to/your/workspace"
    }
  }
}
```

## MCP tools

| Tool | When to call |
|------|-------------|
| `get_change_context` | Before editing — why this code exists, linked PRs/Jira, risks, tests |
| `review_change` | Before finalizing — reviewer concerns, risky assumptions, checklist |
| `explain_why_code_exists` | When something looks surprising — evidence-backed historical explanation |
| `get_file_memory` | Quick file lookup — risk level, Jira keys, recent commits |

## Data sources

Suvadu indexes what you explicitly configure:

| Source | What it reads | Requires |
|--------|--------------|----------|
| Git | Commits, authors, Jira keys in messages | Git CLI |
| Repository files | Path, language, symbols, heuristic summary | — |
| GitHub PRs | Title, body, changed files, review comments, conversation | GitHub token or `gh` CLI |
| Jira Cloud | Issue titles, descriptions, status, comments | Jira API token |

Credentials are stored in `.suvadu/credentials.json` (gitignored) and can be set via `suvadu ui` → Settings.

## CLI reference

```
suvadu init                       # initialize workspace
suvadu repo add <path>            # register a repository
suvadu repo list                  # list registered repos
suvadu repo index <name>          # full re-index
suvadu repo update <name>         # incremental — new commits/PRs only
suvadu repo status <name>         # indexing stats
suvadu status                     # workspace summary
suvadu doctor                     # check prerequisites and auth
suvadu serve                      # start MCP server over stdio
suvadu ui                         # start web dashboard at localhost:7337

suvadu memory file <repo> <path>  # inspect file memory
suvadu explain <repo> <path> --question "..."
suvadu context <repo> --task "..." --file <path> [--compact] [--json]
suvadu review <repo> --diff-summary "..." --file <path> [--compact] [--json]
```

## Privacy

- All indexed data is stored locally in `.suvadu/suvadu.sqlite`
- GitHub API calls are made only for repos you explicitly add with GitHub config
- Jira API calls fetch only keys discovered in your indexed git history
- Credentials are stored in `.suvadu/credentials.json` (gitignored) or environment variables
- No telemetry, no analytics, no cloud backend

## Contributing

Contributions welcome. Please open an issue before a large PR so we can discuss approach.

```bash
git clone https://github.com/mvvishnu7/suvadu
cd suvadu
npm install
npm test
```

## License

MIT © Vishnu Viswambharan
