#!/usr/bin/env bash
# _publish-checks.sh — pre-flight check helpers for publish.sh.
#
# Sourced, not executed. Every function returns 0 on pass, non-zero on fail,
# and prints a one-line "OK"/"FAIL" message via the colour helpers exported
# by publish.sh (`info`, `ok`, `warn`, `fail`).
#
# Bash 3.2 compat (no associative arrays, no `mapfile`).

# shellcheck disable=SC2034  # sourced — variables consumed by publish.sh

set -u

# ---------------------------------------------------------------------------
# verify_clean_tree
#   Aborts unless `git status` reports a clean working tree.
# ---------------------------------------------------------------------------
verify_clean_tree() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    if [ "${DRY_RUN:-0}" = "1" ]; then
      warn "working tree is dirty — would abort in live mode (dry-run continues)"
      return 0
    fi
    fail "working tree is dirty — commit or stash before publishing"
    git status --short | sed 's/^/    /'
    return 1
  fi
  ok "working tree clean"
  return 0
}

# ---------------------------------------------------------------------------
# verify_main_branch
#   Aborts unless the current branch is `main`.
# ---------------------------------------------------------------------------
verify_main_branch() {
  local branch
  branch="$(git branch --show-current)"
  if [ "$branch" != "main" ]; then
    if [ "${DRY_RUN:-0}" = "1" ]; then
      warn "branch is '$branch' (not main) — would abort in live mode (dry-run continues)"
      return 0
    fi
    fail "must be on main branch (currently on '$branch')"
    return 1
  fi
  ok "on main branch"
  return 0
}

# ---------------------------------------------------------------------------
# verify_tests_green
#   Runs the TS test suite (turbo across workspaces) and, unless --skip-python,
#   also runs pytest + ruff + mypy from the python venv.
# ---------------------------------------------------------------------------
verify_tests_green() {
  info "running TS tests (npm test --workspaces)"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    ok "tests would run (dry-run skipped)"
    return 0
  fi
  if ! npm test --workspaces --if-present >/tmp/cs-publish-test.log 2>&1; then
    fail "TS tests failed — see /tmp/cs-publish-test.log"
    tail -20 /tmp/cs-publish-test.log | sed 's/^/    /'
    return 1
  fi
  ok "TS tests green"

  if [ "${SKIP_PYTHON:-0}" = "1" ]; then
    warn "python checks skipped (--skip-python)"
    return 0
  fi

  if [ ! -d "packages/python/.venv" ]; then
    warn "no python venv at packages/python/.venv — skipping python checks"
    return 0
  fi

  info "running python tests + ruff + mypy"
  local venv_python="packages/python/.venv/bin/python"
  if ! (
    cd packages/python && \
    "../../$venv_python" -m pytest -q && \
    "../../$venv_python" -m ruff check src tests && \
    "../../$venv_python" -m mypy src
  ) >/tmp/cs-publish-pytest.log 2>&1; then
    fail "python checks failed — see /tmp/cs-publish-pytest.log"
    tail -20 /tmp/cs-publish-pytest.log | sed 's/^/    /'
    return 1
  fi
  ok "python tests + lint + types green"
  return 0
}

# ---------------------------------------------------------------------------
# verify_typecheck
#   Strict TS typecheck across the monorepo via turbo.
# ---------------------------------------------------------------------------
verify_typecheck() {
  if [ "${DRY_RUN:-0}" = "1" ]; then
    ok "typecheck would run (dry-run skipped)"
    return 0
  fi
  info "running TS typecheck (npx tsc --noEmit across workspaces)"
  if ! npm run typecheck >/tmp/cs-publish-tsc.log 2>&1; then
    fail "typecheck failed — see /tmp/cs-publish-tsc.log"
    tail -20 /tmp/cs-publish-tsc.log | sed 's/^/    /'
    return 1
  fi
  ok "typecheck clean"
  return 0
}

# ---------------------------------------------------------------------------
# verify_npm_resolvable <package> <version>
#   Confirms that `npm view <pkg>@<ver> dist.tarball` returns a tarball URL.
#   Used as a propagation gate between Stage 1 (types) and Stage 2 (sdk).
# ---------------------------------------------------------------------------
verify_npm_resolvable() {
  local pkg="$1"
  local ver="$2"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    info "would verify ${pkg}@${ver} on npm registry"
    return 0
  fi
  local tarball
  tarball="$(npm view "${pkg}@${ver}" dist.tarball 2>/dev/null || true)"
  if [ -z "$tarball" ]; then
    fail "${pkg}@${ver} not yet resolvable on npm — propagation may take ~5min"
    return 1
  fi
  ok "${pkg}@${ver} resolvable (${tarball})"
  return 0
}

# ---------------------------------------------------------------------------
# verify_pypi_credentials
#   We use Trusted Publishing (OIDC) so there are no API tokens to validate.
#   Just sanity-check that `gh auth status` works — `gh release create` is
#   what triggers the workflow.
# ---------------------------------------------------------------------------
verify_pypi_credentials() {
  if ! command -v gh >/dev/null 2>&1; then
    if [ "${DRY_RUN:-0}" = "1" ]; then
      warn "gh CLI not installed — would abort in live mode (dry-run continues)"
      return 0
    fi
    fail "gh CLI not installed — required for python release"
    return 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    if [ "${DRY_RUN:-0}" = "1" ]; then
      warn "gh CLI not authenticated — would abort in live mode (dry-run continues)"
      return 0
    fi
    fail "gh CLI not authenticated — run 'gh auth login'"
    return 1
  fi
  ok "gh CLI authenticated"
  return 0
}
