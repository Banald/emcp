# eMCP documentation

This directory is the **deep-knowledge corpus** for eMCP. The root [`README.md`](../README.md) is the human entry point — start there to install eMCP and get it running. The documents below are for operators running eMCP at depth, contributors modifying the codebase, and AI agents catching up on the project.

> **Agents: start at [`../AGENTS.md`](../AGENTS.md).** It is the source of truth for how to work in this repository — rules, conventions, and escalation points that override default behavior.

## Index

| I want to… | Read |
|---|---|
| Install eMCP on a Linux host (one-command or manual) | [`INSTALL.md`](INSTALL.md) |
| Bootstrap rootless Docker from scratch | [`INSTALL.md`](INSTALL.md#first-time-rootless-docker-setup) |
| Understand the system, pick tech, trace a request | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Look up an env var, schema column, or dependency decision | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Follow (or audit) the security rules | [`SECURITY.md`](SECURITY.md) |
| Manage API keys, run migrations, read metrics | [`OPERATIONS.md`](OPERATIONS.md) |
| Operate the outbound proxy rotation | [`OPERATIONS.md`](OPERATIONS.md#outbound-proxy-rotation) |
| Add or modify an MCP tool | [`TOOL_AUTHORING.md`](TOOL_AUTHORING.md) |
| Add or modify a scheduled worker | [`WORKER_AUTHORING.md`](WORKER_AUTHORING.md) |
| Write tests, hit the coverage gate | [`TESTING.md`](TESTING.md) |

## Document ownership

| Document | What lives here | What does NOT live here |
|---|---|---|
| `INSTALL.md` | One-command install, rootless bootstrap, manual compose, bare-metal, TLS, public ports | Day-2 key management (that's `OPERATIONS.md`) |
| `ARCHITECTURE.md` | Major tech decisions, dependency list, schema, env-var catalog, error hierarchy, data-flow diagrams, proxy egress design | Step-by-step procedures |
| `SECURITY.md` | Numbered rules (hashing, comparison, headers, rate limits, logging, proxy egress, container posture) + audit checklist | Implementation narrative |
| `OPERATIONS.md` | `emcp` CLI, API keys, migrations, graceful shutdown, `/health`, `/metrics`, proxy runbook | Install steps |
| `TOOL_AUTHORING.md` | Tool contract, template, input-schema rules, testing, discovery semantics | Worker authoring |
| `WORKER_AUTHORING.md` | Worker contract, cron syntax, overlap/abort semantics, testing | Tool authoring |
| `TESTING.md` | `node:test` patterns, coverage gate, Testcontainers, CI integration | Production runtime |
