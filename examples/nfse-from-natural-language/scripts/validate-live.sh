#!/usr/bin/env bash
#
# Live LLM smoke — same shape as `validate.sh` but the runtime hits real
# `api.anthropic.com` instead of `@copilotkit/aimock`, and the MCP servers
# spawn with `--demo` so no Nuvem-Fiscal / Z-API credentials are needed.
# A real `ANTHROPIC_API_KEY` is required.
#
# The `--demo` flag lives in `mcp-servers.live.json` (a sibling of the
# test-mode `mcp-servers.json`). This script points the runtime at the
# live config via `CODESPAR_MCP_SERVERS_PATH` so the bridge spawns the
# demo-mode MCP servers. The test-mode path (`validate.sh`) uses the
# default `mcp-servers.json` and stubs tools at the runtime layer with
# `cs.create({ mocks })`, so the two paths stay cleanly separated.
#
# Runtime resolution (same three modes as validate.sh, minus aimock):
#   1. CODESPAR_BASE_URL is set       → use it, do NOT manage lifecycle.
#                                       Caller's runtime must already have
#                                       CODESPAR_MCP_SERVERS_PATH pointed at
#                                       this dir's `mcp-servers.live.json`,
#                                       or the bridge falls back to the
#                                       test-mode config and the spawned
#                                       servers will try real Nuvem / Z-API
#                                       APIs with no credentials.
#   2. CODESPAR_RUNTIME_DIR is set    → boot `node server/start.mjs` from there
#                                       with CODESPAR_MCP_SERVERS_PATH set to
#                                       the live config.
#   3. `docker` is available          → `docker run` of the published image
#                                       (default ghcr.io/codespar/codespar:latest)
#                                       with -e CODESPAR_MCP_SERVERS_PATH set.
#   4. none of the above              → print instructions and exit non-zero
#
# Costs real Anthropic API spend per run (a few cents). Don't wire this
# into CI. Run on demand before pushing changes to: the chat-loop or
# tool-catalog in codespar, the SDK's session.send() in codespar-core,
# or anything that affects the LATAM-commerce system prompt or this
# example's MCP fixtures.

set -euo pipefail

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  cat >&2 <<EOF
validate-live.sh: ANTHROPIC_API_KEY is not set.

This script runs the example against real api.anthropic.com so it can
catch regressions that aimock-based tests cannot (tool-name regex,
invalid model ids, system-prompt issues). Set ANTHROPIC_API_KEY to a
key you're willing to spend a few cents on:

  ANTHROPIC_API_KEY=sk-ant-... npm run validate:live

EOF
  exit 2
fi

SKELETON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SKELETON_DIR"

RUNTIME_PORT="${CODESPAR_RUNTIME_PORT:-3000}"
HEALTH_URL="http://localhost:${RUNTIME_PORT}/health"
RUNTIME_IMAGE="${CODESPAR_RUNTIME_IMAGE:-ghcr.io/codespar/codespar:latest}"

# Mode 1: a runtime is already reachable. Caller owns lifecycle AND env;
# they must have already wired ANTHROPIC_API_KEY and CODESPAR_MCP_SERVERS_PATH
# into the running runtime.
if [ -n "${CODESPAR_BASE_URL:-}" ]; then
  echo "validate-live.sh: using running runtime at $CODESPAR_BASE_URL (lifecycle not managed)"
  echo "validate-live.sh: assuming the runtime already has ANTHROPIC_API_KEY set"
  echo "validate-live.sh: NOTE — that runtime must also have"
  echo "validate-live.sh:        CODESPAR_MCP_SERVERS_PATH=$SKELETON_DIR/mcp-servers.live.json"
  echo "validate-live.sh:        or it will spawn the test-mode MCP servers (no --demo)"
  echo "validate-live.sh:        and the live smoke will try real provider APIs."
  CODESPAR_LIVE_SMOKE=1 npx vitest run live.test.ts
  echo "validate-live.sh: ok"
  exit 0
fi

# Mode 2: local clone. Pass ANTHROPIC_API_KEY through to the spawned runtime.
if [ -n "${CODESPAR_RUNTIME_DIR:-}" ]; then
  if [ ! -f "$CODESPAR_RUNTIME_DIR/server/start.mjs" ]; then
    echo "validate-live.sh: CODESPAR_RUNTIME_DIR=$CODESPAR_RUNTIME_DIR does not look like a codespar/codespar checkout (no server/start.mjs)" >&2
    exit 2
  fi

  RUNTIME_LOG="$SKELETON_DIR/.runtime.log"
  echo "validate-live.sh: starting runtime from $CODESPAR_RUNTIME_DIR (port $RUNTIME_PORT)…"
  (
    cd "$SKELETON_DIR"
    CODESPAR_MCP_SERVERS_PATH="$SKELETON_DIR/mcp-servers.live.json" \
    PORT="$RUNTIME_PORT" \
    ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
    node "$CODESPAR_RUNTIME_DIR/server/start.mjs" \
      > "$RUNTIME_LOG" 2>&1 &
    echo $! > "$SKELETON_DIR/.runtime.pid"
  ) || true

  RUNTIME_PID="$(cat "$SKELETON_DIR/.runtime.pid" 2>/dev/null || echo "")"

  cleanup_clone() {
    if [ -n "${RUNTIME_PID:-}" ] && kill -0 "$RUNTIME_PID" 2>/dev/null; then
      kill "$RUNTIME_PID" 2>/dev/null || true
      wait "$RUNTIME_PID" 2>/dev/null || true
    fi
    rm -f "$SKELETON_DIR/.runtime.pid"
  }
  trap cleanup_clone EXIT INT TERM

  echo "validate-live.sh: polling $HEALTH_URL …"
  for i in $(seq 1 20); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      echo "validate-live.sh: runtime up after ${i}s"
      break
    fi
    if [ "$i" = "20" ]; then
      echo "validate-live.sh: runtime did not become healthy in 20s" >&2
      tail -n 40 "$RUNTIME_LOG" >&2 || true
      exit 3
    fi
    sleep 1
  done

  CODESPAR_BASE_URL="http://localhost:${RUNTIME_PORT}" \
  CODESPAR_LIVE_SMOKE=1 npx vitest run live.test.ts
  echo "validate-live.sh: ok"
  exit 0
fi

# Mode 3: published Docker image. Pass ANTHROPIC_API_KEY +
# CODESPAR_MCP_SERVERS_PATH through. Container cwd is /example (mounted),
# so the relative path resolves to the live config inside the container.
if command -v docker >/dev/null 2>&1; then
  CONTAINER_NAME="codespar-nfse-live-$$"
  RUNTIME_LOG="$SKELETON_DIR/.runtime.log"

  echo "validate-live.sh: starting runtime from $RUNTIME_IMAGE (port $RUNTIME_PORT)…"
  docker run -d --rm \
    --name "$CONTAINER_NAME" \
    -p "$RUNTIME_PORT:3000" \
    -v "$SKELETON_DIR:/example" \
    -w /example \
    -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
    -e CODESPAR_MCP_SERVERS_PATH=./mcp-servers.live.json \
    "$RUNTIME_IMAGE" \
    node /app/server/start.mjs \
    > "$RUNTIME_LOG" 2>&1 || {
      echo "validate-live.sh: docker run failed; check $RUNTIME_LOG" >&2
      exit 3
    }

  cleanup_docker() {
    docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  }
  trap cleanup_docker EXIT INT TERM

  echo "validate-live.sh: polling $HEALTH_URL …"
  for i in $(seq 1 30); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      echo "validate-live.sh: runtime up after ${i}s"
      break
    fi
    if [ "$i" = "30" ]; then
      echo "validate-live.sh: runtime did not become healthy in 30s" >&2
      docker logs "$CONTAINER_NAME" 2>&1 | tail -n 40 >&2 || true
      exit 3
    fi
    sleep 1
  done

  CODESPAR_BASE_URL="http://localhost:${RUNTIME_PORT}" \
  CODESPAR_LIVE_SMOKE=1 npx vitest run live.test.ts
  echo "validate-live.sh: ok"
  exit 0
fi

cat >&2 <<EOF
validate-live.sh: no runtime configured. Pick one:

  Option A (recommended) — install Docker and re-run this script. It
  will pull and run ghcr.io/codespar/codespar:latest automatically:
    https://docs.docker.com/get-docker/
    ANTHROPIC_API_KEY=sk-ant-... npm run validate:live

  Option B — point at an already-running runtime (you own its lifecycle
  AND its ANTHROPIC_API_KEY env var):
    export CODESPAR_BASE_URL=http://localhost:3000
    ANTHROPIC_API_KEY=sk-ant-... npm run validate:live

  Option C — point at a local clone of codespar/codespar (this script
  boots and kills it for you):
    git clone https://github.com/codespar/codespar.git /tmp/codespar
    (cd /tmp/codespar && npm install && npx turbo run build)
    export CODESPAR_RUNTIME_DIR=/tmp/codespar
    ANTHROPIC_API_KEY=sk-ant-... npm run validate:live

  Override the Docker image with CODESPAR_RUNTIME_IMAGE if you need a
  specific tag (default: ghcr.io/codespar/codespar:latest).
EOF
exit 2
