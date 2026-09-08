#!/usr/bin/env bash
# Static contracts for the machine stack: no published ports, data-init gated
# daemon start, targeted ownership fix, supervisor-accepted screen network mode,
# credentials-path consistency, and strict runner flag parsing. Bash-only, offline.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }
compose_file=$root/docker-compose.machine.yml
wrapper=$root/rakazo-runner
installer=$root/install-machine.sh
runner_pkg=$root/../../packages/runner/package.json

bash -n "$wrapper" || fail 'wrapper syntax'
bash -n "$installer" || fail 'installer syntax'

# Outbound-only: the stack publishes nothing to the host.
if grep -qE '^[[:space:]]*ports:' "$compose_file"; then fail 'compose publishes ports'; fi

# Nothing starts before data-init fixed uid 1000 ownership.
count=$(grep -c 'condition: service_completed_successfully' "$compose_file") || true
[[ "$count" -ge 2 ]] || fail 'daemon services do not depend on data-init completing'
if grep -q 'chown -R' "$compose_file"; then fail 'data-init uses a recursive chown'; fi
grep -q 'mkdir -p /data/runner /data/homes' "$compose_file" || fail 'data-init does not create the runner-owned roots'

# The server origin is pairing state, not a required compose variable.
if grep -q 'RAKAZO_SERVER_URL:.*:?' "$compose_file"; then fail 'server origin is still required compose configuration'; fi

# Only values the supervisor itself accepts (resolveScreenNetworkMode).
value=$(sed -n 's/^.*SANDBOX_SCREEN_NETWORK:[[:space:]]*//p' "$compose_file" | tr -d '"')
case "$value" in
  published|internal|isolated) ;;
  *) fail "unsupported SANDBOX_SCREEN_NETWORK: $value" ;;
esac

# The pair guard and the runner home must agree on where credentials land.
grep -q 'RAKAZO_RUNNER_HOME: /data/runner' "$compose_file" || fail 'runner home mismatch'
grep -q '/data/runner/credentials.json' "$compose_file" || fail 'pair guard does not watch the runner credentials'

# The runner package tests from the repository root like every other package.
grep -q '"test": "vitest run --root ../.. packages/runner/src"' "$runner_pkg" || fail 'runner test root is wrong'
if grep -q '\.\./\.\./\.\.' "$runner_pkg"; then fail 'runner test root still escapes the repository'; fi

# Unknown, duplicate, and valueless flags are rejected before Docker is touched.
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
calls=$scratch/calls
: >"$calls"
cat >"$scratch/docker" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$calls"
exit 0
EOF
chmod 755 "$scratch/docker"
for bad in 'pair --code a --code b' 'pair --bogus x' 'pair --code' 'frobnicate'; do
  status=0
  PATH="$scratch:/usr/bin:/bin" bash "$wrapper" $bad >"$scratch/out" 2>&1 || status=$?
  [[ "$status" -eq 2 ]] || fail "wrapper exit for $bad was $status"
  [[ -s "$calls" ]] && fail "wrapper called docker for $bad"
done

echo "ok"
