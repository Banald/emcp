# Security

This document is **strict, enforceable rules**, not guidelines. Consult it before touching anything in `src/core/auth.ts`, `src/lib/redis.ts`, `src/db/`, or any code dealing with credentials, hashing, headers, rate limiting, or input handling.

## Threat model

This server is exposed over HTTPS to multiple external clients authenticated by API key. Assumed adversaries:

- **Stolen API key** — attacker obtains a valid key (phishing, accidental commit, log leak). Mitigation: blacklisting, rate limits, per-key metrics anomaly detection.
- **Database compromise** — attacker reads the `api_keys` table. Mitigation: HMAC with separately-stored pepper means hashes alone don't grant access.
- **DNS rebinding** — malicious website's JavaScript tries to call our server via a victim's browser. Mitigation: Origin and Host header validation.
- **Tool poisoning** — malicious tool description manipulates LLM behavior. Mitigation: tool metadata is reviewed; tools are loaded only from `src/tools/`.
- **Prompt injection via tool output** — a tool returns text that manipulates the calling LLM. Mitigation: tool authors aware; we don't sanitize content (LLM's responsibility), but we never echo unvalidated user input back into our own prompts.
- **Supply chain** — malicious npm package. Mitigation: minimal dependencies, manual approval for additions, lockfile, optional `npm audit signatures` in CI.

## Rule 1: API key hashing — HMAC-SHA256 only

**NEVER** use bcrypt, argon2, scrypt, or PBKDF2 for API keys. They are designed for low-entropy passwords and add 200-500ms per verification. API keys have 256 bits of entropy, where intentional slowness offers zero security benefit and breaks our latency budget.

**Use HMAC-SHA256 with a server-side pepper.** The pepper lives in environment configuration, separate from the database. Database compromise alone does not yield key recovery.

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

const PEPPER = config.apiKeyHmacSecret;  // 32+ bytes, env var, never in DB

export function hashApiKey(key: string): string {
  return createHmac('sha256', PEPPER).update(key).digest('hex');
}

export function verifyApiKey(provided: string, storedHash: string): boolean {
  const computed = hashApiKey(provided);
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

The pepper itself must be:
- Generated with `crypto.randomBytes(32)`.
- Stored in environment configuration (or secrets manager in production).
- **Never** logged, echoed in errors, or committed to the repo.
- Rotated only with a coordinated re-hash of all existing keys (rare).

## Rule 2: Constant-time comparison for all credentials

**NEVER** use `===` or `==` for hashes, tokens, signatures, MAC codes, or any credential comparison. Use `crypto.timingSafeEqual()` — but note its requirements:

- Both buffers must be the same length. Compare lengths first; if mismatched, return false **without** calling `timingSafeEqual` (which throws on length mismatch).
- Convert hex strings to Buffers before comparing.
- This applies even when comparing hashes — the hash itself is not secret, but the comparison pattern protects against timing-based side channels in any future code that derives from this pattern.

## Rule 3: Generate keys with sufficient entropy

```typescript
import { randomBytes } from 'node:crypto';

export function generateApiKey(prefix = 'mcp_live'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}
```

- 32 bytes = 256 bits of entropy. **Do not** reduce.
- Prefix identifies the key environment (`mcp_live`, `mcp_test`) and is stored separately in `key_prefix` for searchable identification.
- Show the raw key to the user **exactly once** at creation. Store only the HMAC hash.
- Use `base64url` (URL-safe, no padding), not hex (longer) or base64 (has `+`, `/`, `=`).

## Rule 4: HTTP header validation

Every request to `/mcp` must have `Origin` and `Host` validated **before** any business logic.

- **Allowed origins** are defined in config (`ALLOWED_ORIGINS=https://app.example.com,https://...`). Wildcards forbidden.
- For requests without an Origin header (server-to-server, curl), apply a stricter policy: require a valid API key with the `allow_no_origin` flag set on it. Default new keys to `false`.
- Reject mismatched `Host` (DNS rebinding defense). The expected host is in config (`PUBLIC_HOST=mcp.example.com`).
- Return **HTTP 403** for header validation failures. Do **not** reveal which header failed in the response body — log it, but respond with a generic "forbidden" message.

```typescript
function validateHeaders(req: IncomingMessage): { ok: true } | { ok: false; reason: string } {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (host !== config.publicHost) return { ok: false, reason: 'host-mismatch' };
  if (origin && !config.allowedOrigins.includes(origin)) return { ok: false, reason: 'origin-not-allowed' };
  return { ok: true };
}
```

## Rule 5: Logging — what to NEVER log

The Pino logger is configured with `redact` paths. Do not work around it.

**Never log:**

- Full API keys, ever. Log the prefix only (`mcp_live_k7Hj9mNqR2`).
- The HMAC pepper, JWT secrets, database passwords, Redis passwords.
- `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key` headers (full values).
- Request bodies for endpoints that may contain credentials (login, key creation).
- Tool inputs that are flagged sensitive in the tool's schema (use `.describe('...').meta({ sensitive: true })` and the logger middleware will redact).

**Always log:**

- Request ID (correlate across services).
- API key prefix and `key_id` (UUID — safe to log, identifies the key without leaking it).
- Tool name, status, duration.
- Errors with stack traces (but not the credentials that caused them).

Pino redaction config (in `src/lib/logger.ts`):

```typescript
const logger = pino({
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      '*.apiKey',
      '*.password',
      '*.secret',
      '*.token',
      '*.hmacSecret',
    ],
    censor: '[REDACTED]',
  },
});
```

## Rule 6: Input handling

Zod validation is the first line of defense, not the last.

- **Length limits**: every string input has a `.max()`. Default to 1000 unless there's a reason to allow more.
- **Control characters**: strip or reject `\x00` (null bytes) in path-like inputs. Use the `safeString` helper in `src/tools/_helpers.ts`.
- **Path traversal**: never construct a filesystem path from user input without `path.resolve()` and a check that the result is within the expected directory. Better: don't accept paths at all — accept identifiers and resolve them yourself.
- **SQL**: parameterized queries only. `pg` placeholders (`$1`, `$2`). Never string-concatenate SQL, even for "trusted" inputs.
- **Shell**: never `exec()` user input. Use `execFile()` with an argument array, and prefer not invoking shells at all.
- **URLs**: if a tool fetches a URL from input, restrict the protocol (`https:` only), block private IP ranges (SSRF defense), and set a fetch timeout.

## Rule 7: Rate limiting

Every API key has a default rate limit applied at the auth middleware layer. Tools may add tighter per-tool limits via metadata.

- Implementation: Redis sliding window via Lua script (atomic, no race conditions).
- Defaults: 60 requests/minute per key (configurable per key via `rate_limit_per_minute` column).
- On exceed: HTTP 429 with `Retry-After` header. Do not consume a "request slot" for the rejected request itself.
- Always return rate limit headers on **all authenticated responses**, not just rejections: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. Pre-auth failures (missing/malformed credentials) cannot report per-key limits and are excluded.

## Rule 8: Auth response codes

| Condition | HTTP | JSON-RPC error code |
|--|--|--|
| Missing `Authorization` header | 401 | -32001 (auth required) |
| Malformed bearer token | 401 | -32002 (invalid token format) |
| Key not found | 401 | -32003 (invalid credentials) |
| Key blacklisted | 403 | -32004 (key blacklisted) |
| Key soft-deleted | 403 | -32005 (key deleted) |
| Rate limit exceeded | 429 | -32029 (rate limited) |
| Origin/Host invalid | 403 | n/a (rejected before JSON-RPC layer) |

Error response messages should be **generic** to avoid leaking enumeration vectors. The detailed reason goes to logs, not to the client. Example: blacklisted and deleted keys both return "Authentication failed" to the client; the audit log distinguishes them.

**Exception**: blacklisted and deleted keys MAY receive distinct messages (`"This API key has been blocked."`, `"This API key has been deleted."`) per product requirements. This is a deliberate trade-off — it leaks status but provides clearer UX for legitimate key holders. Confirmed by user requirements.

## Rule 9: Secrets and configuration

- All secrets in environment variables. Use `node --env-file=.env` (no `dotenv` package).
- `.env` is `.gitignore`'d. `.env.example` is committed with placeholder values and inline comments explaining each variable.
- For production, secrets should come from a secrets manager (Vault, AWS Secrets Manager, etc.) injected as env vars at process start — not from a `.env` file on disk.
- The config module (`src/config.ts`) parses env vars through Zod at startup and **fails loudly** if anything is missing or invalid. No silent defaults for security-relevant config.

## Rule 10: TLS

- TLS termination happens at the reverse proxy (nginx/Caddy). The Node.js process binds to `127.0.0.1` and speaks plain HTTP on the loopback interface only.
- The reverse proxy sets `X-Forwarded-Proto: https` and `X-Forwarded-For: <client-ip>`. The app trusts these headers **only** because it's bound to loopback — direct external connections are impossible.
- HSTS, certificate management, cipher suites — proxy's responsibility.

## Rule 11: Dependency hygiene

- Lockfile (`package-lock.json` or `bun.lockb`) is committed.
- CI runs `npm audit --omit=dev` (or equivalent) and fails on high/critical vulnerabilities.
- Optionally run `npm audit signatures` to verify package signatures.
- New dependencies require user approval (see `AGENTS.md`). Approval criteria includes:
  - Active maintenance (commits in last 6 months).
  - Reasonable transitive dep count.
  - No known CVEs.
  - Justification that no built-in alternative suffices.

## Rule 12: Audit logging

Every authenticated request produces an audit log entry (separate from the operational log). At minimum:

- Timestamp
- API key ID and prefix (never raw key)
- Tool name (or `null` for non-tool endpoints)
- Outcome (success / error category)
- Duration
- Bytes in / out

Audit logs go to a separate Pino transport (file or external sink) and are retained per compliance policy (default: 90 days). They must not be redacted via the operational redaction config — they have their own (stricter) redaction.

## Security checklist (run before merging anything in security-adjacent paths)

- [ ] No `===` on credentials; `timingSafeEqual` used.
- [ ] HMAC pepper read from config, never hardcoded.
- [ ] No credentials in log output (review with `grep` if uncertain).
- [ ] Origin and Host validated.
- [ ] Inputs validated with Zod, with bounds.
- [ ] SQL parameterized.
- [ ] Rate limit applies to the new endpoint.
- [ ] Auth response uses correct HTTP and JSON-RPC codes.
- [ ] Tests cover blacklisted, deleted, missing key paths.
- [ ] Audit log entry produced.
- [ ] If new dep was added: user approved.
