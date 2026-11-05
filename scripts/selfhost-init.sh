#!/bin/sh
# Run from the repository root. Optional path permits isolated installations/tests.
set -eu
umask 077
env_file=${1:-.env}
[ -e "$env_file" ] || cp .env.example "$env_file"
chmod 600 "$env_file"
tmp=$(mktemp "${env_file}.XXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM
secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}
# Preserve nonempty assignments; recognize CRLF, quoted empties and whitespace.
for key in BETTER_AUTH_SECRET POSTGRES_PASSWORD CLICKHOUSE_PASSWORD CLICKHOUSE_QUERY_PASSWORD; do
  if awk -v key="$key" '
    $0 ~ "^" key "=" { value=substr($0,length(key)+2); gsub(/\r$/, "", value); if (value !~ /^[ \t]*$/ && value != "\"\"" && value != "\047\047") filled=1 }
    END { exit !filled }' "$env_file"; then continue; fi
  generated=$(secret)
  [ "${#generated}" -eq 64 ] || { echo 'Secret generation failed' >&2; exit 1; }
  awk -v key="$key" -v generated="$generated" '
    $0 ~ "^" key "=" { print key "=" generated; found=1; next }
    { sub(/\r$/, ""); print }
    END { if (!found) print key "=" generated }' "$env_file" > "$tmp"
  cat "$tmp" > "$env_file"
done
chmod 600 "$env_file"
printf '%s\n' 'Environment initialized; existing populated secrets preserved.'
