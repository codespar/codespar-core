#!/usr/bin/env bash
#
# Live LLM smoke — same two boleto-expiry fiscal scenarios as validate.sh, but the runtime
# hits real api.anthropic.com instead of @copilotkit/aimock. The runtime still
# runs in test mode (CODESPAR_TEST_MODE_ENABLED=true) with the demo meta-tool
# plugin loaded, so the session `mocks` answer each meta-tool — no Asaas /
# Nuvem-Fiscal / WhatsApp credentials are needed. What is real is the model:
# Claude actually reads the OVERDUE boleto + the NF-e amendment-window state and decides the
# remediation.
#
# A real ANTHROPIC_API_KEY is required. Costs a few cents per run. Do NOT wire
# this into CI — it is probabilistic and spends real API budget. Run on demand
# before pushing changes to the chat loop, tool catalog, system prompt,
# session.send(), or this example's scenario shapes.
#
# Runtime resolution (same three modes as validate.sh, minus aimock):
#   1. CODESPAR_BASE_URL is set    → use it, do NOT manage its lifecycle. Caller's
#                                    runtime must already have a real
#                                    ANTHROPIC_API_KEY, CODESPAR_TEST_MODE_ENABLED=true,
#                                    and CODESPAR_PLUGINS pointed at this dir's
#                                    demo-plugin.mjs.
#   2. CODESPAR_RUNTIME_DIR is set → boot `node server/start.mjs` from there with a
#                                    real ANTHROPIC_API_KEY, test mode on, and the
#                                    demo plugin loaded (NO ANTHROPIC_BASE_URL — calls
#                                    land on real Anthropic).
#   3. `docker` is available       → `docker run` of the published image with the
#                                    same env.
#   4. none of the above           → print instructions and exit non-zero

set -euo pipefail

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  cat >&2 <<EOF
validate-live.sh: ANTHROPIC_API_KEY is not set.

This script runs the example against real api.anthropic.com so it can catch
regressions aimock-based tests cannot (tool-name regex, invalid model ids,
system-prompt issues that change whether the agent makes the fiscal-state call correctly). No
provider credentials are needed — only an Anthropic key you're willing to spend
a few cents on:

  ANTHROPIC_API_KEY=sk-ant-... npm run validate:live

EOF
  exit 2
fi

SKELETON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SKELETON_DIR"

RUNTIME_PORT="${CODESPAR_RUNTIME_PORT:-3000}"
HEALTH_URL="http://localhost:${RUNTIME_PORT}/health"
RUNTIME_IMAGE="${CODESPAR_RUNTIME_IMAGE:-ghcr.io/codespar/codespar:latest}"

# Mode 1: a runtime is already reachable. Caller owns lifecycle AND env.
if [ -n "${CODESPAR_BASE_URL:-}" ]; then
  echo "validate-live.sh: using running runtime at $CODESPAR_BASE_URL (lifecycle not managed)"
  echo "validate-live.sh: NOTE — that runtime must already have a real ANTHROPIC_API_KEY,"
  echo "validate-live.sh:        CODESPAR_TEST_MODE_ENABLED=true, and"
  echo "validate-live.sh:        CODESPAR_PLUGINS=$SKELETON_DIR/demo-plugin.mjs,"
  echo "validate-live.sh:        or the live smoke will not make the fiscal-state call correctly."
  CODESPAR_LIVE_SMOKE=1 npx vitest run live.test.ts
  echo "validate-live.sh: ok"
  exit 0
fi

# Mode 2: local clone. Boot the runtime with a real Anthropic key, test mode on,
# and the demo plugin loaded.
if [ -n "${CODESPAR_RUNTIME_DIR:-}" ]; then
  if [ ! -f "$CODESPAR_RUNTIME_DIR/server/start.mjs" ]; then
    echo "validate-live.sh: CODESPAR_RUNTIME_DIR=$CODESPAR_RUNTIME_DIR does not look like a codespar/codespar checkout (no server/start.mjs)" >&2
    exit 2
  fi

  RUNTIME_LOG="$SKELETON_DIR/.runtime.log"
  echo "validate-live.sh: starting runtime from $CODESPAR_RUNTIME_DIR (port $RUNTIME_PORT)…"
  (
    cd "$SKELETON_DIR"
    CODESPAR_TEST_MODE_ENABLED=true \
    PORT="$RUNTIME_PORT" \
    ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
    CODESPAR_PLUGINS="$SKELETON_DIR/demo-plugin.mjs" \
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

# Mode 3: published Docker image. Container cwd is /example (mounted) so the
# demo plugin and the @codespar/types import resolve from the mounted dir.
if command -v docker >/dev/null 2>&1; then
  CONTAINER_NAME="codespar-example-boleto-expiry-fiscal-remediation-live-$$"
  RUNTIME_LOG="$SKELETON_DIR/.runtime.log"

  echo "validate-live.sh: starting runtime from $RUNTIME_IMAGE (port $RUNTIME_PORT)…"
  docker run -d --rm \
    --name "$CONTAINER_NAME" \
    -p "$RUNTIME_PORT:3000" \
    -v "$SKELETON_DIR:/example" \
    -w /example \
    -e CODESPAR_TEST_MODE_ENABLED=true \
    -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
    -e CODESPAR_PLUGINS="/example/demo-plugin.mjs" \
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

  Option A (recommended) — install Docker and re-run this script. It will pull
  and run ghcr.io/codespar/codespar:latest with test mode + the demo plugin
  wired in:
    https://docs.docker.com/get-docker/
    ANTHROPIC_API_KEY=sk-ant-... npm run validate:live

  Option B — point at an already-running runtime (you own its lifecycle AND its
  ANTHROPIC_API_KEY, CODESPAR_TEST_MODE_ENABLED=true, and CODESPAR_PLUGINS):
    export CODESPAR_BASE_URL=http://localhost:3000
    ANTHROPIC_API_KEY=sk-ant-... npm run validate:live

  Option C — point at a local clone of codespar/codespar (this script boots and
  kills it for you):
    git clone https://github.com/codespar/codespar.git /tmp/codespar
    (cd /tmp/codespar && npm install && npx turbo run build)
    export CODESPAR_RUNTIME_DIR=/tmp/codespar
    ANTHROPIC_API_KEY=sk-ant-... npm run validate:live

  Override the Docker image with CODESPAR_RUNTIME_IMAGE if you need a specific
  tag (default: ghcr.io/codespar/codespar:latest).
EOF
exit 2
