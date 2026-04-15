# Contributing to CodeSpar

Thanks for your interest in contributing to the CodeSpar SDK.

## Local Setup

```bash
git clone https://github.com/codespar/codespar-core.git
cd codespar-core
npm install
npm run build
```

## Running Tests

```bash
npm test
```

To run tests for a specific package:

```bash
npx turbo run test --filter=@codespar/core
```

## Development Workflow

1. Fork the repository and create a feature branch from `main`.
2. Make your changes and ensure all checks pass:
   ```bash
   npx turbo run build typecheck test
   ```
3. Open a pull request against `main` with a clear description.

## Code Style

- TypeScript with strict mode enabled.
- ESM-only (`"type": "module"` in every package).
- Keep public APIs minimal and well-documented.
- Write tests for new functionality.

## Pull Request Guidelines

- Keep PRs focused on a single change.
- Include tests for bug fixes and new features.
- Update relevant documentation if APIs change.
- All CI checks must pass before merge.

## Questions?

Open an issue or reach out at support@codespar.dev.
