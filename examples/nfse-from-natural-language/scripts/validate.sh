#!/usr/bin/env bash
#
# Service invoice from natural language — boots @copilotkit/aimock as a
# stand-in Anthropic API, verifies a runtime is reachable, then runs
# the vitest spec against it.
#
# Runtime resolution (first match wins):
#   1. CODESPAR_BASE_URL is set       → use it, do NOT manage its lifecycle.
#                                       Operator must already have configured
#                                       that runtime with
#                                       ANTHROPIC_BASE_URL=http://localhost:4010
#                                       (or the LLM calls will hit the real
#                                       Anthropic API) AND
#                                       CODESPAR_TEST_MODE_ENABLED=true (or the
#                                       session create rejects the mocks field).
#   2. CODESPAR_RUNTIME_DIR is set    → boot `node server/start.mjs` from there
#                                       with ANTHROPIC_BASE_URL pointed at the
#                                       local aimock and test mode enabled.
#                                       This is the canonical recommended path.
#   3. none of the above              → print instructions and exit non-zero
#
# Tool responses come from the `mocks` field on cs.create(), intercepted
# by the runtime before the MCP bridge. That requires the runtime to run
# with CODESPAR_TEST_MODE_ENABLED=true. ANTHROPIC_API_KEY is a
# placeholder — the SDK requires a value, aimock ignores it.

set -euo pipefail

SKELETON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SKELETON_DIR"

RUNTIME_PORT="${CODESPAR_RUNTIME_PORT:-3000}"
HEALTH_URL="http://localhost:${RUNTIME_PORT}/health"
AIMOCK_PORT="${AIMOCK_PORT:-4010}"
AIMOCK_FIXTURE="$SKELETON_DIR/fixtures/aimock-fixtures.json"
AIMOCK_LOG="$SKELETON_DIR/.aimock.log"
AIMOCK_PID_FILE="$SKELETON_DIR/.aimock.pid"

# ── aimock lifecycle ─────────────────────────────────────────────────
# Started BEFORE any runtime resolution path so the local-clone mode can
# point its ANTHROPIC_BASE_URL at it. The CODESPAR_BASE_URL path also
# starts aimock but warns the operator that the *already running* runtime
# must already be configured to talk to it.

start_aimock() {
  if [ ! -f "$AIMOCK_FIXTURE" ]; then
    echo "validate.sh: missing aimock fixture at $AIMOCK_FIXTURE" >&2
    exit 2
  fi
  echo "validate.sh: starting aimock on port $AIMOCK_PORT…"
  # Bind to 0.0.0.0 so the runtime can reach aimock regardless of how it
  # resolves the host. aimock defaults to 127.0.0.1.
  npx -p @copilotkit/aimock llmock --validate-on-load \
      -p "$AIMOCK_PORT" -h 0.0.0.0 -f "$AIMOCK_FIXTURE" \
      > "$AIMOCK_LOG" 2>&1 &
  echo $! > "$AIMOCK_PID_FILE"

  for i in $(seq 1 20); do
    # aimock returns 404 at `/` when alive (no route registered there);
    # that's a positive liveness signal — the process is responding.
    # `-f` is omitted on purpose so 4xx is still a "got a response."
    code="$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:$AIMOCK_PORT" 2>/dev/null || echo "000")"
    if echo "$code" | grep -qE "^(2|3|4)"; then
      echo "validate.sh: aimock up after ${i}s (HTTP $code at root)"
      return 0
    fi
    if [ "$i" = "20" ]; then
      echo "validate.sh: aimock did not respond in 20s (last code: $code)" >&2
      echo "--- last 40 lines of aimock log ---" >&2
      tail -n 40 "$AIMOCK_LOG" >&2 || true
      stop_aimock
      exit 3
    fi
    sleep 1
  done
}

stop_aimock() {
  if [ -f "$AIMOCK_PID_FILE" ]; then
    local pid
    pid="$(cat "$AIMOCK_PID_FILE" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
    rm -f "$AIMOCK_PID_FILE"
  fi
}

# Mode 1: a runtime is already reachable. Just start aimock and run
# the test. Operator owns the runtime lifecycle AND the runtime's
# ANTHROPIC_BASE_URL + test-mode configuration; we warn loudly.
if [ -n "${CODESPAR_BASE_URL:-}" ]; then
  echo "validate.sh: using running runtime at $CODESPAR_BASE_URL (lifecycle not managed)"
  echo "validate.sh: NOTE — that runtime must already be configured with"
  echo "validate.sh:        ANTHROPIC_BASE_URL=http://localhost:$AIMOCK_PORT"
  echo "validate.sh:        or session.send() will reach the real Anthropic API."
  echo "validate.sh: NOTE — that runtime must also have"
  echo "validate.sh:        CODESPAR_TEST_MODE_ENABLED=true or session create"
  echo "validate.sh:        fails with HTTP 501 mocks_not_permitted."
  start_aimock
  trap stop_aimock EXIT INT TERM
  npx vitest run
  echo "validate.sh: ok"
  exit 0
fi

# Mode 2 (canonical recommended): explicit clone path. Boot the runtime
# from this directory (so the bridge reads `./mcp-servers.json`), export
# ANTHROPIC_BASE_URL so its Anthropic SDK calls aimock, and turn on test
# mode so the `mocks` field on cs.create() is honoured.
if [ -n "${CODESPAR_RUNTIME_DIR:-}" ]; then
  if [ ! -d "$CODESPAR_RUNTIME_DIR" ]; then
    echo "validate.sh: CODESPAR_RUNTIME_DIR=$CODESPAR_RUNTIME_DIR does not exist" >&2
    exit 2
  fi
  if [ ! -f "$CODESPAR_RUNTIME_DIR/server/start.mjs" ]; then
    echo "validate.sh: $CODESPAR_RUNTIME_DIR does not look like a codespar/codespar checkout (no server/start.mjs)" >&2
    exit 2
  fi

  start_aimock

  RUNTIME_LOG="$SKELETON_DIR/.runtime.log"
  echo "validate.sh: starting runtime from $CODESPAR_RUNTIME_DIR (port $RUNTIME_PORT)…"
  (
    cd "$SKELETON_DIR"
    CODESPAR_TEST_MODE_ENABLED=true \
    PORT="$RUNTIME_PORT" \
    ANTHROPIC_BASE_URL="http://localhost:$AIMOCK_PORT" \
    ANTHROPIC_API_KEY="placeholder" \
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
    stop_aimock
  }
  trap cleanup_clone EXIT INT TERM

  echo "validate.sh: polling $HEALTH_URL …"
  for i in $(seq 1 20); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      echo "validate.sh: runtime up after ${i}s"
      break
    fi
    if [ "$i" = "20" ]; then
      echo "validate.sh: runtime did not become healthy in 20s" >&2
      echo "--- last 40 lines of runtime log ---" >&2
      tail -n 40 "$RUNTIME_LOG" >&2 || true
      exit 3
    fi
    sleep 1
  done

  CODESPAR_BASE_URL="http://localhost:${RUNTIME_PORT}" \
  npx vitest run

  echo "validate.sh: ok"
  exit 0
fi

# Mode 3: nothing configured — fail loud.
#
# NOTE — the published ghcr.io/codespar/codespar:latest image and the
# current latest v* tag (v0.2.1) predate the mocks plumbing, so there is
# no docker on-ramp for this test yet. Point at a sibling clone of
# codespar/codespar main that includes the mocks support (commit 5830dc4
# or later on main).
cat >&2 <<EOF
validate.sh: no runtime configured. Pick one:

  Option C (recommended) — point at a local clone of codespar/codespar
  main (this script boots and kills it for you, wires ANTHROPIC_BASE_URL
  at the local aimock, and turns on test mode so the mocks field is
  honoured). The clone MUST include the mocks support (commit 5830dc4 or
  later on main):
    git clone https://github.com/codespar/codespar.git /tmp/codespar \\
      && (cd /tmp/codespar && git checkout main && npm install && npx turbo run build) \\
      && export CODESPAR_RUNTIME_DIR=/tmp/codespar \\
      && export CODESPAR_TEST_MODE_ENABLED=true
    npm run validate

  Option B — point at an already-running runtime. The script does NOT
  manage that runtime's lifecycle. Make sure it is already configured
  with ANTHROPIC_BASE_URL=http://localhost:4010 (so session.send() lands
  on the aimock this script boots, NOT the real Anthropic API) AND
  CODESPAR_TEST_MODE_ENABLED=true (or session create fails with HTTP 501
  mocks_not_permitted):
    export CODESPAR_BASE_URL=http://localhost:3000
    npm run validate

  Override the aimock port with AIMOCK_PORT (default: 4010).
EOF
exit 2
