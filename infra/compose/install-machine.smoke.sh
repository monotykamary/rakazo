#!/usr/bin/env bash
# Exercise the machine installer and host wrapper with fake Docker, OpenSSL,
# uname and mktemp, a scratch checkout copy, and an isolated HOME. No real
# install runs and no real host state is touched: every write lands in scratch.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

home=$scratch/home
fakebin=$scratch/bin
calls=$scratch/docker-calls
mkdir -p "$home/.local" "$fakebin"

# Run against a copy of the owned files so no test writes land in the real
# checkout (the generated env file holds a secret).
compose_dir=$scratch/infra/compose
computer_dir=$scratch/infra/sandboxes/computer
mkdir -p "$compose_dir" "$computer_dir"
for file in install-machine.sh rakazo-runner docker-compose.machine.yml Dockerfile; do
  cp -- "$root/$file" "$compose_dir/$file"
done
: >"$computer_dir/Dockerfile"

cat >"$fakebin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_CALLS"
if [[ "${1:-}" == compose ]]; then
  verb=""
  i=2
  while ((i <= $#)); do
    case "${!i}" in
      --env-file|-f) i=$((i + 2)) ;;
      *) verb="${!i}"; break ;;
    esac
  done
  case "$verb" in
    version) [[ -z "${FAKE_NO_COMPOSE:-}" ]] || exit 1 ;;
    ps) printf 'container\n' ;;
    *) exit 0 ;;
  esac
fi
exit 0
EOF

cat >"$fakebin/openssl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "openssl $*" >>"$FAKE_CALLS"
if [[ "${1:-}" == rand && "${2:-}" == -hex ]]; then
  printf '%s\n' 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  exit 0
fi
exit 1
EOF

cat >"$fakebin/uname" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${MACHINE_SMOKE_UNAME:-Linux}"
EOF

cat >"$fakebin/mktemp" <<EOF
#!/usr/bin/env bash
printf '%s\n' "mktemp \$*" >>"\$FAKE_CALLS"
exec "$(command -v mktemp)" "\$@"
EOF
chmod 755 "$fakebin"/*

mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
env_file=$compose_dir/.env.machine
export FAKE_CALLS=$calls
export HOME=$home
PATH_WITH_FAKES=$fakebin:/usr/bin:/bin
installer=$compose_dir/install-machine.sh
wrapper=$compose_dir/rakazo-runner

# macOS must be refused explicitly before anything runs.
: >"$calls"
MACHINE_SMOKE_UNAME=Darwin PATH=$PATH_WITH_FAKES bash "$installer" >"$scratch/out" 2>&1 && fail "macOS install succeeded"
grep -q 'Linux only' "$scratch/out" || fail "macOS refusal not explicit"
[[ -e "$env_file" ]] && fail "macOS run created configuration"
[[ -s "$calls" ]] && fail "macOS run invoked docker or openssl"

# A missing Compose plugin must be named, not crash.
: >"$calls"
FAKE_NO_COMPOSE=1 PATH=$PATH_WITH_FAKES bash "$installer" >"$scratch/out" 2>&1 && fail "install succeeded without the compose plugin"
grep -q 'Compose plugin' "$scratch/out" || fail "compose plugin failure not explicit"
[[ -e "$env_file" ]] && fail "failed install created configuration"

# First install: secret generated, 0600 config, images built, stack started.
: >"$calls"
PATH=$PATH_WITH_FAKES bash "$installer" >"$scratch/out" 2>&1 || fail "first install failed"
grep -Eq '^SANDBOX_SUPERVISOR_TOKEN=[0-9a-f]{64}$' "$env_file" || fail "no random supervisor secret in configuration"
[[ "$(mode "$env_file")" == 600 ]] || fail "configuration is not 0600"
grep -q '^RAKAZO_IMAGE=rakazo/app$' "$env_file" || fail "app image pin missing"
grep -q '^RAKAZO_COMPUTER_IMAGE_TAG=machine$' "$env_file" || fail "computer image pin missing"
grep -Fq 'build -f '$compose_dir'/Dockerfile -t rakazo/app:machine' "$calls" || fail "app image not built"
grep -Fq 'build -t rakazo/computer:machine' "$calls" || fail "computer image not built"
grep -Fq 'compose --env-file '$env_file' -f '$compose_dir'/docker-compose.machine.yml up -d' "$calls" || fail "stack not started"
grep -q '^mktemp ' "$calls" || fail "installer bypassed mktemp"
[[ -L $home/.local/bin/rakazo-runner ]] || fail "rakazo-runner not linked into ~/.local/bin"
[[ $(readlink "$home/.local/bin/rakazo-runner") == "$wrapper" ]] || fail "wrapper symlink target wrong"
grep -q 'Add .* to PATH' "$scratch/out" || fail "PATH hint missing"

# Update: secrets kept, images rebuilt, stack refreshed.
token_before=$(grep '^SANDBOX_SUPERVISOR_TOKEN=' "$env_file")
: >"$calls"
PATH=$PATH_WITH_FAKES bash "$installer" >"$scratch/out" 2>&1 || fail "update install failed"
grep -Fq "$token_before" "$env_file" || fail "update regenerated the supervisor secret"
grep -q 'Existing machine configuration updated' "$scratch/out" || fail "update path not taken"
grep -Fq "build -f $compose_dir/Dockerfile -t rakazo/app:machine" "$calls" || fail "update did not rebuild"
[[ "$(mode "$env_file")" == 600 ]] || fail "update loosened configuration permissions"

# Wrapper pair: forwards to a one-shot container, then restarts a running daemon.
: >"$calls"
PATH=$PATH_WITH_FAKES bash "$home/.local/bin/rakazo-runner" pair --server https://s.example --code rk_p_abc --name lab >"$scratch/out" 2>&1 || fail "wrapper pair failed"
grep -Fq 'run --rm runner bun run --filter @rakazo/runner cli pair --server https://s.example --code rk_p_abc --name lab' "$calls" || fail "pair command not forwarded exactly"
grep -Fq 'restart runner' "$calls" || fail "running daemon not restarted after pairing"

# Unknown, duplicate, and valueless flags are rejected before Docker runs.
for bad in 'pair --server https://s.example --code rk_p_abc --code rk_p_abc' 'pair --server https://s.example --code rk_p_abc --bogus x' 'pair --server https://s.example --code' 'pair --code rk_p_abc' 'start --bogus x' 'stop extra' 'logs extra' 'frobnicate'; do
  : >"$calls"
  PATH=$PATH_WITH_FAKES bash "$wrapper" $bad >"$scratch/out" 2>&1 && fail "wrapper accepted: $bad"
  [[ -s "$calls" ]] && fail "wrapper called docker for: $bad"
done

echo "ok"
