# Contributing to Publume Core

Thank you for improving Publume Core. Contributions are welcome through issues
and pull requests in the public repository.

## Before you start

- Search existing issues and pull requests.
- Open a proposal before making a large public API, storage, or workflow change.
- Report vulnerabilities through the process in `SECURITY.md`.
- Keep source code, documentation, tests, commits, and issue content in English.

## Development setup

```bash
git clone https://github.com/Publume/core.git
cd core
bun install --frozen-lockfile
bun run check
```

Use Bun 1.3.14 or newer. Tests must not require production credentials or mutate
real repositories.

## Making a change

1. Create a focused branch from `main`.
2. Keep configuration and external data fail-closed.
3. Add or update tests for user-visible behavior.
4. Run `bun run format`, then `bun run check`.
5. Review the complete diff for secrets, generated artifacts, and unrelated edits.

Prefer small modules and platform APIs. New dependencies require a clear runtime
need, compatible license, maintained upstream, and an explanation in the pull
request.

## Pull requests

A pull request should explain:

- the problem and intended user outcome;
- public configuration or contract changes;
- verification performed;
- compatibility, security, and operational risks;
- follow-up work that is intentionally outside the change.

Maintainers may ask for changes before merging. Approval does not guarantee an
immediate release.

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0.
