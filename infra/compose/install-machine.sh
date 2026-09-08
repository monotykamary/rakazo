#!/usr/bin/env bash
# Install the machine runner stack from a reviewed Rakazo checkout on a Linux
# machine. Generates the 0600 machine configuration with a random supervisor
# secret on first install; later runs update an existing installation and keep
# its secrets. Never publishes a host port.
set -Eeuo pipefail

fail() { printf '%s\n' "$1" >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$source_dir/../.." && pwd)
env_file="$source_dir/.env.machine"

if [[ $(uname -s) != Linux ]]; then
  fail 'The machine runner installs on Linux only. Connect macOS and Windows desktop clients to the shared server (see docs/always-on.md).'
fi
for tool in docker openssl; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required on the machine host."
done
docker compose version >/dev/null 2>&1 || fail 'The Docker Compose plugin is required: docker compose version failed.'
[[ -f "$source_dir/docker-compose.machine.yml" ]] || fail 'The checkout is missing infra/compose/docker-compose.machine.yml.'
[[ -f "$source_dir/Dockerfile" ]] || fail 'The checkout is missing infra/compose/Dockerfile.'
[[ -f "$root/infra/sandboxes/computer/Dockerfile" ]] || fail 'The checkout is missing infra/sandboxes/computer.'
[[ ! -L "$env_file" ]] || fail 'Refusing a symlinked machine environment file.'

# Compose must use this machine's own secret, not anything from the caller's shell.
unset SANDBOX_SUPERVISOR_TOKEN RAKAZO_IMAGE RAKAZO_IMAGE_TAG RAKAZO_COMPUTER_IMAGE RAKAZO_COMPUTER_IMAGE_TAG
umask 077

if [[ ! -e "$env_file" ]]; then
  token=$(openssl rand -hex 32)
  [[ -n "$token" ]] || fail 'Could not generate the supervisor secret.'
  temporary=$(mktemp "$source_dir/.env.machine.XXXXXX")
  trap 'rm -f -- "$temporary"' EXIT
  {
    printf 'SANDBOX_SUPERVISOR_TOKEN=%s\n' "$token"
    printf 'RAKAZO_IMAGE=rakazo/app\n'
    printf 'RAKAZO_IMAGE_TAG=machine\n'
    printf 'RAKAZO_COMPUTER_IMAGE=rakazo/computer\n'
    printf 'RAKAZO_COMPUTER_IMAGE_TAG=machine\n'
  } >"$temporary"
  chmod 600 "$temporary"
  mv -- "$temporary" "$env_file"
  trap - EXIT
  printf '%s\n' 'Machine configuration written.'
else
  grep -Eq '^SANDBOX_SUPERVISOR_TOKEN=.+$' "$env_file" || fail 'The existing machine configuration has no supervisor secret; fix or remove .env.machine.'
  temporary=$(mktemp "$source_dir/.env.machine.XXXXXX")
  trap 'rm -f -- "$temporary"' EXIT
  awk '
    /^RAKAZO_IMAGE=/ { print "RAKAZO_IMAGE=rakazo/app"; next }
    /^RAKAZO_IMAGE_TAG=/ { print "RAKAZO_IMAGE_TAG=machine"; next }
    /^RAKAZO_COMPUTER_IMAGE=/ { print "RAKAZO_COMPUTER_IMAGE=rakazo/computer"; next }
    /^RAKAZO_COMPUTER_IMAGE_TAG=/ { print "RAKAZO_COMPUTER_IMAGE_TAG=machine"; next }
    { print }
  ' "$env_file" >"$temporary"
  chmod 600 "$temporary"
  mv -- "$temporary" "$env_file"
  trap - EXIT
  printf '%s\n' 'Existing machine configuration updated.'
fi

docker build -f "$source_dir/Dockerfile" -t rakazo/app:machine "$root"
docker build -t rakazo/computer:machine "$root/infra/sandboxes/computer"
# data-init fixes uid 1000 ownership first; the daemon services depend on it
# completing, so nothing starts before the volume is owned correctly.
docker compose --env-file "$env_file" -f "$source_dir/docker-compose.machine.yml" up -d

if [[ -z ${HOME:-} ]]; then
  fail 'Set HOME to link the rakazo-runner command.'
fi
bin_dir=$HOME/.local/bin
mkdir -p -- "$bin_dir"
ln -sfn -- "$source_dir/rakazo-runner" "$bin_dir/rakazo-runner"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) printf '%s\n' "Add $bin_dir to PATH to run rakazo-runner directly." ;;
esac
printf '%s\n' 'Machine stack started. Pair it with: rakazo-runner pair --server https://your-rakazo-server --code <rk_p_...>'
