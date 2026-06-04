# Contributing to Suvadu

## Development setup

```bash
git clone https://github.com/mvvishnu7/suvadu
cd suvadu
npm install
npm test          # builds and runs all tests
```

## Project structure

```
src/
  cli/            # CLI entry point and commands
  api/            # HTTP server for the web UI
  config/         # Config loading, credentials, GitHub auth
  domain/         # Core types
  indexing/       # Git, GitHub, Jira indexers
  mcp/            # MCP server
  retrieval/      # Context builder — the core product logic
  storage/        # MemoryStore interface and SQLite implementation
  utils/          # Shared utilities
tests/            # Unit and integration tests
ui/               # Vite/React/Tailwind dashboard (standalone npm project)
```

## Before opening a PR

- Run `npm test` — all 29 tests must pass
- Keep changes focused — one concern per PR
- The retrieval logic (`src/retrieval/contextBuilder.ts`) is the most sensitive area — changes there need test coverage

## Key design principles

1. **Source-backed or silent** — don't emit a claim without a PR, commit, or Jira ticket backing it
2. **Local-first** — no data leaves the machine without explicit user configuration
3. **No filler** — risky assumptions only emit when backed by evidence, not keyword matches
