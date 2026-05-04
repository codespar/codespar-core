# Publishing checklist

CodeSpar Core ships three packages on each release:

| Package           | Registry | Path                |
|-------------------|----------|---------------------|
| `@codespar/types` | npm      | `packages/types/`   |
| `@codespar/sdk`   | npm      | `packages/core/`    |
| `codespar`        | PyPI     | `packages/python/`  |

Run `scripts/publish.sh` to ship a release. The script gates on:

1. Clean tree, on `main`, tests green, typecheck clean (TS + Python)
2. Verifies `@codespar/types` resolves on npm before publishing `@codespar/sdk`
3. 2FA prompt for each `npm publish` (no token storage; OTP read from stdin)
4. `gh release create` for Python (triggers `publish-python.yml` workflow which
   uploads via PyPI Trusted Publishing / OIDC)

## Order matters

```
@codespar/types  →  @codespar/sdk  →  codespar (PyPI)
```

`@codespar/types` ships first because the SDK + Python package reference the
shared wire shapes. If types isn't resolvable on the npm registry, the SDK
publish stage aborts with the propagation message.

Adapter packages (`@codespar/managed-agents-adapter`, `@codespar/vercel`,
`@codespar/claude`, `@codespar/openai`, `@codespar/mcp`, `@codespar/cli`) pin
`@codespar/sdk` semver-major. Since 0.x → 0.x is still a 0.x range, adapters
stay on `^0.3.0` and **don't** need bumping unless they consume new methods.

## Recovery from partial failure

- **`npm publish` failed mid-flight**: re-run with
  `--skip-types` / `--skip-sdk` to skip stages that already shipped.
- **types published but SDK can't see it yet (registry returns 404)**: this
  is normal — first-time scoped publishes can take ~5 min to propagate. Wait
  and re-run with `--skip-types`.
- **Python release succeeded but never reached PyPI**: check the workflow
  run on Actions (`gh run list --workflow=publish-python.yml`). Trusted
  Publishing OIDC token issuance is occasionally delayed; re-running the
  workflow job is safe.

## CLI

```
bash scripts/publish.sh [--dry-run] [--skip-types|--skip-sdk|--skip-python]
                       [--types-only|--sdk-only|--python-only] [--help]
```

`--dry-run` prints the full plan with no side effects (no publish, no
push, no `gh release`). Use this before every release to sanity-check.

## Never

- **Bump versions in `package.json` / `pyproject.toml` from this script.**
  Versions are bumped manually and reviewed in a PR. The script asserts the
  on-disk versions match `TYPES_VERSION` / `SDK_VERSION` / `PYTHON_VERSION`
  constants and ships those exact values.
- **Skip the test/typecheck pre-flight.** F2.M3 shipped a regression
  because tests were skipped under time pressure. Don't.
- **Cache npm tokens or hardcode credentials.** Each `npm publish` re-prompts
  for OTP via stdin. PyPI uses OIDC trusted publishing — no API token at all.
- **Modify `.github/workflows/publish-python.yml`** as part of a release.
  That workflow is the trusted-publishing trust boundary; changes need their
  own PR + review.
