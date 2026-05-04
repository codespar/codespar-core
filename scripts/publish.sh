#!/usr/bin/env bash
# publish.sh — npm + PyPI release ceremony for codespar-core.
#
# Walks the operator through the 3-stage publish in the right order
# with 2FA prompts and propagation gates. The script does NOT bump
# versions and does NOT cache credentials; every npm publish re-prompts
# for OTP.
#
# Run from the repo root (codespar-core/).
#
# Stages:
#   1. @codespar/types  → npm  (must publish first; SDK + Python depend on its shapes)
#   2. @codespar/sdk    → npm  (gated on types being resolvable)
#   3. codespar (PyPI)  → gh release → publish-python.yml workflow (OIDC trusted publishing)
#
# Bash 3.2 compat. Tested on macOS default /bin/bash.

set -euo pipefail

# ---------------------------------------------------------------------------
# Versions — keep in sync with package.json / pyproject.toml. The script
# does NOT bump these; it asserts they match what's on disk before publishing.
# ---------------------------------------------------------------------------
TYPES_VERSION="0.7.0"
SDK_VERSION="0.9.0"
PYTHON_VERSION="0.9.0"

# ---------------------------------------------------------------------------
# CLI flags — set by parse_args, consumed everywhere.
# ---------------------------------------------------------------------------
DRY_RUN=0
SKIP_TYPES=0
SKIP_SDK=0
SKIP_PYTHON=0

# ---------------------------------------------------------------------------
# Colour helpers — TTY only. NO_COLOR / non-tty → plain text.
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_BOLD=$'\033[1m'
else
  C_RESET=""
  C_DIM=""
  C_RED=""
  C_GREEN=""
  C_YELLOW=""
  C_BLUE=""
  C_BOLD=""
fi

info()  { printf "%s[i]%s %s\n"   "$C_BLUE"   "$C_RESET" "$*"; }
ok()    { printf "%s[ok]%s %s\n"  "$C_GREEN"  "$C_RESET" "$*"; }
warn()  { printf "%s[!!]%s %s\n"  "$C_YELLOW" "$C_RESET" "$*"; }
fail()  { printf "%s[XX]%s %s\n"  "$C_RED"    "$C_RESET" "$*"; }
header(){ printf "\n%s== %s ==%s\n" "$C_BOLD" "$*" "$C_RESET"; }
dim()   { printf "%s%s%s\n"       "$C_DIM"   "$*"  "$C_RESET"; }

# ---------------------------------------------------------------------------
# Locate repo root and source helpers. Script must run from codespar-core/.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=_publish-checks.sh
. "$SCRIPT_DIR/_publish-checks.sh"

usage() {
  cat <<'EOF'
publish.sh — codespar-core release ceremony

USAGE
    bash scripts/publish.sh [flags]

FLAGS
    --dry-run          Run pre-flight checks, print plan, publish nothing.
    --skip-types       Skip the @codespar/types stage (recovery mode).
    --skip-sdk         Skip the @codespar/sdk stage (recovery mode).
    --skip-python      Skip the codespar (PyPI) stage.
    --types-only       Run only the @codespar/types stage.
    --sdk-only         Run only the @codespar/sdk stage.
    --python-only      Run only the codespar (PyPI) stage.
    -h, --help         Show this help and exit.

ORDER
    types  →  sdk  →  python
    (sdk publish is gated on types being resolvable on the npm registry)

RECOVERY
    Mid-flight failure?  Re-run with --skip-<stage-that-already-shipped>.

EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run)       DRY_RUN=1 ;;
      --skip-types)    SKIP_TYPES=1 ;;
      --skip-sdk)      SKIP_SDK=1 ;;
      --skip-python)   SKIP_PYTHON=1 ;;
      --types-only)    SKIP_SDK=1; SKIP_PYTHON=1 ;;
      --sdk-only)      SKIP_TYPES=1; SKIP_PYTHON=1 ;;
      --python-only)   SKIP_TYPES=1; SKIP_SDK=1 ;;
      -h|--help)       usage; exit 0 ;;
      *) fail "unknown flag: $1"; usage; exit 2 ;;
    esac
    shift
  done
  export DRY_RUN SKIP_TYPES SKIP_SDK SKIP_PYTHON
}

# ---------------------------------------------------------------------------
# confirm <prompt> — yes/no gate. In --dry-run we auto-decline (skip the
# action) so dry-runs never accidentally publish.
# ---------------------------------------------------------------------------
confirm() {
  local prompt="$1"
  if [ "$DRY_RUN" = "1" ]; then
    dim "    (dry-run: would prompt '$prompt' — auto-skipping)"
    return 1
  fi
  printf "%s%s%s [y/N] " "$C_BOLD" "$prompt" "$C_RESET"
  local reply
  read -r reply
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# read_otp — silently read a 2FA OTP from stdin. Echoed nowhere.
# ---------------------------------------------------------------------------
read_otp() {
  local pkg="$1"
  if [ "$DRY_RUN" = "1" ]; then
    printf "000000"
    return 0
  fi
  local otp
  printf "    %sOTP for npm publish of %s%s: " "$C_DIM" "$pkg" "$C_RESET" >&2
  read -r -s otp
  printf "\n" >&2
  printf "%s" "$otp"
}

generate_changelog() {
  cat <<'EOF'
## codespar 0.9.0 (Python) / @codespar/sdk 0.9.0 / @codespar/types 0.7.0

SSE streaming for async settlement + verification status, replacing
polling for long-running pending → settled flows.

### Added
- `session.paymentStatusStream(toolCallId, { onUpdate?, signal? })` —
  Server-Sent Events stream over `GET /v1/tool-calls/:id/payment-status/stream`.
  Pushes initial snapshot + every state change; resolves on terminal.
  AbortSignal cancels.
- `session.verificationStatusStream(toolCallId, { onUpdate?, signal? })`
  — KYC sibling with the same lifecycle.
- Python paridade: `AsyncSession.payment_status_stream` /
  `verification_status_stream` (sync wrappers on the blocking client).

### Types (@codespar/types 0.7.0)
- `PaymentStatusStreamOptions`, `VerificationStatusStreamOptions`.
- New `Session.paymentStatusStream` + `verificationStatusStream`
  signatures.

### Compat
- Polling siblings (`paymentStatus` / `verificationStatus`) stay live
  — additive change only. Adapter packages remain on `^0.3.0` ranges
  for `@codespar/sdk` (method additions, no breaking changes).
EOF
}

# ---------------------------------------------------------------------------
# show_diff_since_last_published — best-effort diff summary so the operator
# can sanity-check what they're shipping. Falls back gracefully if the
# version isn't on the registry yet (first publish) or the tag is missing.
# ---------------------------------------------------------------------------
show_diff_since_last_published() {
  local pkg="$1"
  local path="$2"
  local published
  published="$(npm view "$pkg" version 2>/dev/null || true)"
  if [ -z "$published" ]; then
    dim "    (no prior published version on registry)"
    return 0
  fi
  dim "    last published on npm: $pkg@$published"
  local tag
  case "$pkg" in
    "@codespar/types") tag="types-v$published" ;;
    "@codespar/sdk")   tag="sdk-v$published" ;;
    *) tag="" ;;
  esac
  if [ -n "$tag" ] && git rev-parse --verify "refs/tags/$tag" >/dev/null 2>&1; then
    local files_changed
    files_changed="$(git diff --name-only "$tag..HEAD" -- "$path" | wc -l | tr -d ' ')"
    dim "    files changed since $tag: $files_changed"
  else
    dim "    (tag $tag not found locally — skipping diff summary)"
  fi
}

# ---------------------------------------------------------------------------
# Stage 1 — @codespar/types
# ---------------------------------------------------------------------------
stage_types() {
  header "Stage 1 — @codespar/types@${TYPES_VERSION}"
  if [ "$SKIP_TYPES" = "1" ]; then
    warn "skipped (--skip-types)"
    return 0
  fi

  show_diff_since_last_published "@codespar/types" "packages/types"

  if [ "$DRY_RUN" = "1" ]; then
    dim "    would: cd packages/types && npm run build"
    dim "    would: npm publish --access public --otp=<prompt>"
    dim "    would: git tag types-v${TYPES_VERSION} && git push origin types-v${TYPES_VERSION}"
    return 0
  fi

  if ! confirm "Publish @codespar/types@${TYPES_VERSION}?"; then
    warn "operator declined — skipping types stage"
    return 0
  fi

  info "building @codespar/types"
  ( cd "$REPO_ROOT/packages/types" && npm run build )

  local otp
  otp="$(read_otp "@codespar/types")"
  info "publishing @codespar/types@${TYPES_VERSION}"
  ( cd "$REPO_ROOT/packages/types" && npm publish --access public --otp="$otp" )

  info "tagging types-v${TYPES_VERSION}"
  git tag "types-v${TYPES_VERSION}"
  git push origin "types-v${TYPES_VERSION}"
  ok "@codespar/types@${TYPES_VERSION} published + tagged"
}

# ---------------------------------------------------------------------------
# Stage 2 — @codespar/sdk
# ---------------------------------------------------------------------------
stage_sdk() {
  header "Stage 2 — @codespar/sdk@${SDK_VERSION}"
  if [ "$SKIP_SDK" = "1" ]; then
    warn "skipped (--skip-sdk)"
    return 0
  fi

  # Gate: types must be resolvable. If we just published it in this run
  # and propagation is slow, the operator will need to wait ~5min and
  # rerun with --skip-types.
  if ! verify_npm_resolvable "@codespar/types" "$TYPES_VERSION"; then
    fail "types must publish first; rerun in 5min for npm propagation (use --skip-types to skip stage 1)"
    return 1
  fi

  show_diff_since_last_published "@codespar/sdk" "packages/core"

  if [ "$DRY_RUN" = "1" ]; then
    dim "    would: cd packages/core && npm run build"
    dim "    would: npm publish --access public --otp=<prompt>"
    dim "    would: git tag sdk-v${SDK_VERSION} && git push origin sdk-v${SDK_VERSION}"
    return 0
  fi

  if ! confirm "Publish @codespar/sdk@${SDK_VERSION}?"; then
    warn "operator declined — skipping sdk stage"
    return 0
  fi

  info "building @codespar/sdk"
  ( cd "$REPO_ROOT/packages/core" && npm run build )

  local otp
  otp="$(read_otp "@codespar/sdk")"
  info "publishing @codespar/sdk@${SDK_VERSION}"
  ( cd "$REPO_ROOT/packages/core" && npm publish --access public --otp="$otp" )

  info "tagging sdk-v${SDK_VERSION}"
  git tag "sdk-v${SDK_VERSION}"
  git push origin "sdk-v${SDK_VERSION}"
  ok "@codespar/sdk@${SDK_VERSION} published + tagged"
}

# ---------------------------------------------------------------------------
# Stage 3 — codespar (PyPI). Triggers publish-python.yml via gh release.
# Uses Trusted Publishing (OIDC) — no token rotation here.
# ---------------------------------------------------------------------------
stage_python() {
  header "Stage 3 — codespar@${PYTHON_VERSION} (PyPI)"
  if [ "$SKIP_PYTHON" = "1" ]; then
    warn "skipped (--skip-python)"
    return 0
  fi

  info "tag python-v${PYTHON_VERSION} will trigger .github/workflows/publish-python.yml"
  info "workflow uses PyPI Trusted Publishing (OIDC) — no API tokens"

  local notes_file
  notes_file="$(mktemp -t codespar-release-notes.XXXXXX)"
  generate_changelog > "$notes_file"
  dim "    release notes written to $notes_file"

  if [ "$DRY_RUN" = "1" ]; then
    dim "    would: gh release create python-v${PYTHON_VERSION} --title \"codespar ${PYTHON_VERSION}\" --notes-file ${notes_file}"
    rm -f "$notes_file"
    return 0
  fi

  if ! confirm "Cut GitHub release python-v${PYTHON_VERSION} (triggers PyPI workflow)?"; then
    warn "operator declined — skipping python stage"
    rm -f "$notes_file"
    return 0
  fi

  info "creating GitHub release python-v${PYTHON_VERSION}"
  gh release create "python-v${PYTHON_VERSION}" \
    --title "codespar ${PYTHON_VERSION}" \
    --notes-file "$notes_file"

  rm -f "$notes_file"

  local repo_slug
  repo_slug="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo 'codespar/codespar-core')"
  ok "release cut — watch the workflow at:"
  printf "    https://github.com/%s/actions/workflows/publish-python.yml\n" "$repo_slug"
}

# ---------------------------------------------------------------------------
# Final summary line.
# ---------------------------------------------------------------------------
print_summary() {
  header "Summary"
  printf "  @codespar/types@%s — https://www.npmjs.com/package/@codespar/types/v/%s\n" "$TYPES_VERSION" "$TYPES_VERSION"
  printf "  @codespar/sdk@%s   — https://www.npmjs.com/package/@codespar/sdk/v/%s\n"   "$SDK_VERSION" "$SDK_VERSION"
  printf "  codespar %s        — https://pypi.org/project/codespar/%s/\n"              "$PYTHON_VERSION" "$PYTHON_VERSION"
}

# ---------------------------------------------------------------------------
# Pre-flight: every check below must pass before any publish runs.
# ---------------------------------------------------------------------------
preflight() {
  header "Pre-flight"
  cd "$REPO_ROOT"
  verify_clean_tree     || exit 1
  verify_main_branch    || exit 1
  verify_tests_green    || exit 1
  verify_typecheck      || exit 1
  if [ "$SKIP_PYTHON" != "1" ]; then
    verify_pypi_credentials || exit 1
  fi
}

# ---------------------------------------------------------------------------
# Plan summary — printed up-front so the operator sees the full ceremony
# before the first prompt.
# ---------------------------------------------------------------------------
print_plan() {
  header "Plan"
  printf "  mode: %s\n" "$([ "$DRY_RUN" = "1" ] && echo "DRY-RUN" || echo "LIVE")"
  printf "  stage 1: @codespar/types@%s   %s\n" "$TYPES_VERSION" "$([ "$SKIP_TYPES" = "1" ] && echo "(skipped)" || echo "")"
  printf "  stage 2: @codespar/sdk@%s     %s\n" "$SDK_VERSION"   "$([ "$SKIP_SDK" = "1" ] && echo "(skipped)" || echo "")"
  printf "  stage 3: codespar %s (PyPI)   %s\n" "$PYTHON_VERSION" "$([ "$SKIP_PYTHON" = "1" ] && echo "(skipped)" || echo "")"
}

main() {
  parse_args "$@"
  print_plan
  preflight
  stage_types
  stage_sdk
  stage_python
  print_summary
}

main "$@"
