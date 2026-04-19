# AGENTS.md

> **Read this file first, every session.** It is the source of truth for how to work in this repository. When in doubt, this file wins over your training intuitions.

## What this project is

A production-grade **Model Context Protocol (MCP) server named eMCP** written in TypeScript. It exposes tools to MCP clients (Claude, IDEs, agents) over **Streamable HTTP** transport with custom API key authentication, per-key usage metrics, and a croner-backed scheduler that runs drop-in cron workers in a separate process.

This server is **production from day one**. It is not a prototype. Every line of code must be reviewed with that in mind.

## Golden rules (these are non-negotiable)

### 🔒 Security — STRICT

- **NEVER** log API keys, tokens, secrets, request bodies that may contain credentials, or full headers. Log only the key prefix (first 12 characters) when identifying a key.
- **NEVER** use `===` or `==` to compare secrets, hashes, or tokens. Use `crypto.timingSafeEqual()`.
- **NEVER** hash API keys with bcrypt or argon2. Use `HMAC-SHA256` with a server-side pepper. (Reason: in `docs/SECURITY.md`.)
- **NEVER** pass user/tool input directly to `child_process.exec()`, SQL string concatenation, file paths, or `eval`-like constructs.
- **ALWAYS** validate `Origin` and `Host` headers on the MCP HTTP endpoint (DNS rebinding defense).
- **ALWAYS** use parameterized queries (`pg` placeholders `$1, $2`).
- **ALWAYS** consult `docs/SECURITY.md` before touching anything in `src/core/auth.ts`, `src/lib/redis.ts`, `src/db/`, or any file dealing with credentials, hashing, headers, or rate limiting.

### 📦 Dependencies — STRICT

- **NEVER add a new runtime or dev dependency without stopping and asking the user first.** Open a conversation:
  > "I want to add `<package>` because `<concrete reason>`. Alternatives I considered: `<list>`. Reason I rejected them: `<explanation>`. Approve?"
- **NEVER** `npm install` without explicit approval, even if it seems obviously needed.
- **PREFER** Node.js built-ins (`node:crypto`, `node:fs`, `node:http`, `node:test`, `node:url`, `--env-file`) over any npm package.
- The approved dependency list lives in `docs/ARCHITECTURE.md`. Adding to it is a deliberate decision, not an implementation detail.

### 🧪 Testing — STRICT

- **Coverage gate is 95% lines, 95% functions, 90% branches.** CI enforces this. Do not weaken thresholds to make a build pass — write the missing tests.
- **Every new tool, worker, repository, and middleware ships with tests in the same commit.** A PR adding production code without tests is incomplete.
- Use `node:test` only. Do not introduce vitest, jest, mocha, or any other test framework.
- Patterns and examples: `docs/TESTING.md`.

### 🛠️ Code style and structure — COLLABORATIVE

These are defaults, not laws. Deviate when there's a good reason, and note the reason in the commit message.

- TypeScript `strict: true` is on. Do not weaken it. Prefer narrow types over `any`/`unknown` casts.
- ESM only (`"type": "module"`). Use `.ts` extensions in imports (Node.js native type stripping requires this).
- One tool per file in `src/tools/`. Group related tools in subdirectories. See `docs/TOOL_AUTHORING.md`.
- Pure functions for business logic; thin wrappers for I/O. Makes testing trivial.
- Co-locate unit tests next to source: `foo.ts` + `foo.test.ts`. Integration tests live in `tests/integration/`.
- Errors: throw typed errors from `src/lib/errors.ts`. Don't throw bare strings or generic `Error` for known failure modes.
- Logging: use the shared `logger` from `src/lib/logger.ts`. Never `console.log` outside of one-off scripts.

## Quick reference

### Start SearXNG (required for web-search tool)
```bash
docker compose up -d searxng
```

### Run the server (dev)
```bash
node --env-file=.env --watch src/index.ts
```

### Run the worker (dev)
```bash
node --env-file=.env --watch src/workers/index.ts
```

### Run tests
```bash
npm test                    # unit tests only
npm run test:coverage       # unit tests with coverage gate (95/95/90)
npm run test:integration    # integration tests (requires Docker)
npm run test:all            # coverage + integration
```

### Lint and format
```bash
npx biome check .           # check only
npx biome check --write .   # check and auto-fix
```

### Typecheck
```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.test.json
```

### Run in production
Primary path is Docker Compose — one Dockerfile, one compose file, full stack:
```bash
docker compose up -d        # postgres + redis + searxng + migrate + server + worker + caddy
```
See `README.md` "Deploy with Docker Compose" for first-time setup (secrets, `.env`). Bare-metal (no Docker) is supported as a fallback:
```bash
npm run build               # tsc → dist/
npm start                   # node dist/index.js
npm run start:worker        # node dist/workers/index.js
# Or via PM2 with ecosystem.config.cjs
```

### Run migrations
```bash
node --env-file=.env src/db/migrate.ts up
```

### Manage API keys
```bash
node --env-file=.env src/cli/keys.ts create --name "..."
node --env-file=.env src/cli/keys.ts list
node --env-file=.env src/cli/keys.ts blacklist <id-or-prefix>
# See docs/OPERATIONS.md for the full command reference.
```

### Build for production
```bash
npx tsc
```

## Where to find deeper context

| If you're working on... | Read this first |
|--|--|
| Architecture decisions, tech choices, dependencies, schema, env vars, error hierarchy | `docs/ARCHITECTURE.md` |
| Adding/modifying a tool in `src/tools/` | `docs/TOOL_AUTHORING.md` |
| Adding/modifying a worker in `src/workers/` | `docs/WORKER_AUTHORING.md` |
| Auth, hashing, headers, rate limiting, anything credential-adjacent | `docs/SECURITY.md` |
| API key CLI, migrations, shutdown, health, metrics | `docs/OPERATIONS.md` |
| Writing tests, coverage requirements, test patterns | `docs/TESTING.md` |

## When you're unsure

Stop and ask the user. This codebase prefers a 30-second clarifying question over a 30-minute wrong implementation. Specifically ask before:

- Adding any dependency
- Changing the database schema
- Touching auth, crypto, or rate-limiting code in a non-trivial way
- Restructuring directories or moving files between modules
- Modifying CI configuration or coverage thresholds
- Disabling a lint rule or weakening a TypeScript setting

## Commit conventions

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `ci:`.
- One logical change per commit. Tests in the same commit as the code they cover.
- Prefer a scope when it clarifies the change: `feat(auth): implement HMAC key hashing`.
- If you deviated from a `docs/` convention, explain why in the body.
- Never include co-authored by Claude or reveal that you are an AI in the commits.
