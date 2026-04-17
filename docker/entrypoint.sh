#!/bin/sh
# Echo container entrypoint.
#
# 1. Expand any *_FILE env vars into their bare-name equivalent, reading the
#    file contents (convention used by the postgres, mysql, and redis images).
#    This lets Docker Compose `secrets:` feed values to the app without
#    requiring src/config.ts to learn about file paths.
# 2. Assemble DATABASE_URL from DATABASE_{HOST,PORT,USER,DB,PASSWORD} when the
#    caller hasn't provided one directly. The password is URL-encoded so
#    special characters (+, /, =) from `openssl rand -base64` don't corrupt
#    the connection string.
# 3. exec the given command. `tini` (PID 1) handles signal forwarding.

set -eu

# --- Expand *_FILE envs into plain envs ------------------------------------
for file_var in $(env | sed -n 's/=.*//;/_FILE$/p'); do
    name="${file_var%_FILE}"
    current=$(eval "printf '%s' \"\${$name:-}\"")
    if [ -n "$current" ]; then
        continue
    fi
    path=$(eval "printf '%s' \"\${$file_var}\"")
    if [ -z "$path" ]; then
        continue
    fi
    if [ ! -r "$path" ]; then
        echo "entrypoint: $file_var=$path is not readable" >&2
        exit 1
    fi
    # Command substitution strips trailing newlines, matching how the postgres
    # image reads its *_FILE secrets — keeps passwords consistent across images.
    value=$(cat "$path")
    export "$name=$value"
done

# --- Assemble DATABASE_URL from parts if not provided ----------------------
if [ -z "${DATABASE_URL:-}" ] && [ -n "${DATABASE_HOST:-}" ]; then
    DATABASE_URL=$(node <<'NODE_EOF'
const u = encodeURIComponent;
const user = u(process.env.DATABASE_USER || 'mcp');
const db = process.env.DATABASE_DB || 'mcp';
const host = process.env.DATABASE_HOST;
const port = process.env.DATABASE_PORT || '5432';
const pw = process.env.DATABASE_PASSWORD;
if (!host) {
    process.stderr.write('entrypoint: DATABASE_HOST missing\n');
    process.exit(1);
}
const auth = pw ? `${user}:${u(pw)}` : user;
process.stdout.write(`postgres://${auth}@${host}:${port}/${db}`);
NODE_EOF
)
    export DATABASE_URL
fi

exec "$@"
