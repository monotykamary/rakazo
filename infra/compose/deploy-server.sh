#!/usr/bin/env bash
set -Eeuo pipefail

# Run from a reviewed checkout on the destination server after explicit deployment consent.
# Bot-guided preparation must not expose credentials or claim this migrates existing data.
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$source_dir/../.." && pwd)
host=""
owner=""
directory="./rakazo-server"
prepare_only=false
build=false
usage() {
  printf '%s\n' 'Usage: deploy-server.sh --host app.example.com --allow-signup owner@example.com [--directory DIR] [--build] [--prepare-only]'
}
fail() { printf '%s\n' "$1" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --host|--allow-signup|--directory)
      (($# >= 2)) || { usage >&2; exit 2; }
      case "$1" in
        --host) host="$2" ;;
        --allow-signup) owner="$2" ;;
        --directory) directory="$2" ;;
      esac
      shift 2 ;;
    --prepare-only) prepare_only=true; shift ;;
    --build) build=true; shift ;;
    --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ "$host" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$ ]] || fail 'Use a DNS hostname, not a URL or IP address.'
[[ "$host" != *..* && "$host" != *.-* && "$host" != *-.* && "$host" != *.local && "$host" != *.localhost ]] || fail 'Use a public DNS hostname.'
[[ "$owner" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || fail 'Set one signup email address.'
[[ -n "$directory" ]] || fail 'Set an installation directory.'
# Compose must use this installation's credentials and origin, not the caller's shell.
unset POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB BETTER_AUTH_SECRET ENCRYPTION_KEY
unset SCREEN_PROXY_SECRET SANDBOX_SUPERVISOR_TOKEN BETTER_AUTH_URL WEB_ORIGIN API_URL RAKAZO_HOST
unset SIGNUPS_ENABLED SIGNUP_ALLOWLIST
umask 077
mkdir -p -- "$directory"
cd -- "$directory"
[[ ! -L .env ]] || fail 'Refusing a symlinked environment file.'
if [[ -e .env ]]; then
  grep -Fxq "RAKAZO_HOST=$host" .env || fail 'Existing server hostname differs. Edit its configuration explicitly.'
  grep -Fxq "SIGNUP_ALLOWLIST=$owner" .env || fail 'Existing signup policy differs. Edit its configuration explicitly.'
fi
for file in docker-compose.images.yml docker-compose.server.yml .env.images.example Caddyfile.prod; do
  [[ ! -L "$file" ]] || fail 'Refusing a symlinked deployment file.'
  cp -- "$source_dir/$file" "$file"
done
new_env=false
[[ -e .env ]] || new_env=true
bash "$source_dir/install-images.sh" --local --prepare-only
if [[ "$new_env" == true ]]; then
  temporary=$(mktemp .env.server.XXXXXX)
  trap 'rm -f -- "$temporary"' EXIT
  awk -v host="$host" -v owner="$owner" '
    /^RAKAZO_HOST=/ { print "RAKAZO_HOST=" host; next }
    /^(BETTER_AUTH_URL|WEB_ORIGIN|API_URL)=/ { split($0,a,"="); print a[1] "=https://" host; next }
    /^SIGNUP_ALLOWLIST=/ { print "SIGNUP_ALLOWLIST=" owner; next }
    { print }
  ' .env > "$temporary"
  chmod 600 "$temporary"
  mv -- "$temporary" .env
  trap - EXIT
fi
if [[ "$prepare_only" == true ]]; then
  printf '%s\n' 'Server files prepared. Review .env before starting. Re-run without --prepare-only to start.'
  exit 0
fi
# An email allowlist does not prove ownership without verification delivery.
if grep -Eq '^SIGNUPS_ENABLED=(true|1)$' .env; then
  grep -Eq '^SMTP_URL=.+$' .env && grep -Eq '^EMAIL_FROM=.+$' .env || fail 'Configure SMTP_URL and EMAIL_FROM in .env before enabling public signup, or disable signup for an existing installation.'
fi
if [[ "$build" == true ]]; then
  docker build -f "$source_dir/Dockerfile" -t rakazo/app:server "$root"
  docker build -t rakazo/computer:server "$root/infra/sandboxes/computer"
  export RAKAZO_IMAGE=rakazo/app RAKAZO_IMAGE_TAG=server
  export RAKAZO_COMPUTER_IMAGE=rakazo/computer RAKAZO_COMPUTER_IMAGE_TAG=server
  # Persist the selected images for subsequent restarts and operator updates.
  temporary=$(mktemp .env.server.XXXXXX)
  trap 'rm -f -- "$temporary"' EXIT
  awk '
    /^RAKAZO_IMAGE=/ { print "RAKAZO_IMAGE=rakazo/app"; next }
    /^RAKAZO_IMAGE_TAG=/ { print "RAKAZO_IMAGE_TAG=server"; next }
    /^RAKAZO_COMPUTER_IMAGE=/ { print "RAKAZO_COMPUTER_IMAGE=rakazo/computer"; next }
    /^RAKAZO_COMPUTER_IMAGE_TAG=/ { print "RAKAZO_COMPUTER_IMAGE_TAG=server"; next }
    { print }
  ' .env > "$temporary"
  chmod 600 "$temporary"
  mv -- "$temporary" .env
  trap - EXIT
  docker compose --env-file .env -f docker-compose.images.yml -f docker-compose.server.yml pull postgres data-init caddy
else
  docker compose --env-file .env -f docker-compose.images.yml -f docker-compose.server.yml pull
fi
docker compose --env-file .env -f docker-compose.images.yml -f docker-compose.server.yml up -d --pull never --wait --wait-timeout 300
printf 'Server started. Connect every client to https://%s after HTTPS is ready.\n' "$host"
