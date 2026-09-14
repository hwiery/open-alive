#!/usr/bin/env bash
# One-shot installer for a source checkout of open-alive.
#
#   git clone <repo-url> open-alive && cd open-alive && ./scripts/install.sh
#
# 1. checks Node.js >= 20 and enables pnpm (via corepack) if it is missing
# 2. installs dependencies and builds the self-contained npm bundle
# 3. installs the `open-alive` command globally from that bundle
# 4. runs `open-alive setup` (skip with --no-setup)
#
# Nothing here needs sudo unless your global npm prefix does; see
# https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_SETUP=1
for arg in "$@"; do
  case "$arg" in
    --no-setup) RUN_SETUP=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

fail() { echo "✗ $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js 20+ is required: https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20+ is required (found $(node -v))"
echo "✓ Node.js $(node -v)"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "• pnpm not found — enabling it with corepack"
  corepack enable >/dev/null 2>&1 || fail "Could not enable pnpm. Install it with: npm install -g pnpm"
fi
echo "✓ pnpm $(pnpm -v)"

command -v claude >/dev/null 2>&1 && echo "✓ Claude Code found" \
  || echo "! Claude Code not found on PATH — install it before using open-alive: https://docs.anthropic.com/en/docs/claude-code"

cd "$ROOT"
echo ""
echo "[1/3] Installing dependencies..."
pnpm install --frozen-lockfile

echo "[2/3] Building..."
bash scripts/build-npm.sh >/dev/null

echo "[3/3] Installing the open-alive command..."
TARBALL="$(cd npm-dist && npm pack --silent | tail -1)"
npm install -g "$ROOT/npm-dist/$TARBALL"
rm -f "$ROOT/npm-dist/$TARBALL"
command -v open-alive >/dev/null 2>&1 || fail "open-alive was installed but is not on PATH — add \"$(npm prefix -g)/bin\" to PATH"
echo "✓ $(command -v open-alive) ($(open-alive version))"

if [ "$RUN_SETUP" -eq 1 ]; then
  open-alive setup
else
  echo ""
  echo "Next: open-alive setup"
fi
