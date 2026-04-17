# Docker secrets

This directory holds secrets consumed by the compose stack (`compose.yaml`)
via Docker's `secrets:` mechanism. Each file is mounted read-only at
`/run/secrets/<name>` inside the services that declare it.

**Never commit these files.** They are git-ignored via a `.gitignore` rule
at the repo root.

## Required files

| File | How to generate | Consumed by |
|---|---|---|
| `postgres_password.txt` | `openssl rand -base64 24` | postgres, migrate, mcp-server, mcp-worker |
| `api_key_hmac_secret.txt` | `openssl rand -base64 32` | migrate, mcp-server, mcp-worker |

Trailing newlines from shell redirection are tolerated — both the postgres
image's entrypoint and Echo's entrypoint strip them.

## One-time setup

```bash
mkdir -p secrets
openssl rand -base64 24 > secrets/postgres_password.txt
openssl rand -base64 32 > secrets/api_key_hmac_secret.txt
chmod 0644 secrets/*.txt
```

`0644` (not `0600`) is required: Docker Compose `secrets:` bind-mounts these
files into the service container with host permissions preserved, and the
non-root container user (`echo`, UID 10001) must be able to read them.
Mode `0600` breaks the mount for that user, and the entrypoint refuses to
start with `$_FILE is not readable`. The files still must not be committed
(enforced by the repo's `.gitignore`).

## Rotation

### `api_key_hmac_secret.txt`

This is the HMAC pepper for API keys (`docs/SECURITY.md` Rule 1). **Rotating
it invalidates every existing key** — they are hashed against the pepper.

In production, rotate only with a coordinated re-hash of the `api_keys`
table. There is no in-repo tooling for that today; script it deliberately.

### `postgres_password.txt`

Rotating the Postgres password requires:

1. `docker compose exec postgres psql -U "$POSTGRES_USER" -c "ALTER USER mcp WITH PASSWORD 'new-pw';"`
2. Update `secrets/postgres_password.txt`.
3. `docker compose restart mcp-server mcp-worker migrate`.

## Why aren't all secrets here?

See `.env.example`. The SearXNG secret (`SEARXNG_SECRET`) is kept in `.env`
because it only salts session cookies and the bot limiter, both of which are
irrelevant in this deployment (no user sessions, limiter disabled). The
other two secrets protect authentication and data, so they live here.
