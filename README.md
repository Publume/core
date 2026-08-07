# Publume Core

[![CI](https://github.com/Publume/core/actions/workflows/ci.yml/badge.svg)](https://github.com/Publume/core/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Publume Core is a configuration-first personal information and publishing
engine. It collects recent source material, applies deterministic filters and an
AI publication gate, generates source-linked summaries, commits validated
content to a separate site repository, and can deliver it through optional
notification channels.

The project is designed for scheduled GitHub Actions runs. It has no database,
long-running server, or bundled site theme.

> **Project status:** Publume Core is pre-1.0. Configuration and storage contracts
> may change before the first stable release.

## How it works

```text
RSS / Atom / JSON / HTML
            |
            v
normalize -> deduplicate -> recency and hard filters
            |
            v
        AI publication gate
            |
            v
   multilingual generation -> runtime validation
            |
            v
       target site repository -> site deployment workflow
            |
            v
 Telegram / webhooks / ntfy / Matrix / email
```

A scheduled run can succeed without publishing anything. Candidates that are
duplicate, stale, unsupported, low-value, unsafe, or below the configured score
threshold are rejected before they reach the target repository.

## Requirements

- [Bun](https://bun.sh/) 1.3.14 or newer
- Git 2.39 or newer
- An OpenAI-compatible chat completions endpoint
- A writable target Git repository
- A compatible theme repository for first-time site creation

## Deploy from GitHub

For a self-hosted deployment, start from the green **Use this template** button
on [`Publume/core`](https://github.com/Publume/core). Do not fork the repository
or use the local-development commands below as the deployment entry point.

The shortest working path is:

1. create your own Core repository from this template;
2. create a separate, empty public repository for the website;
3. enable GitHub Actions as the website repository's Pages source;
4. add the required Core repository variables and secrets;
5. run **Generate and publish** once in `initial` mode.

Follow the GitHub manual deployment guide in
[English](docs/deployment.en.md) or [简体中文](docs/deployment.md) for the exact
settings, token permissions, success checks, and common failure fixes.

## Local quick start

```bash
git clone https://github.com/Publume/core.git
cd core
bun install --frozen-lockfile
cp .env.example .env
```

Configure at least these values in `.env`:

```env
AI_PROVIDER=openai-compatible
AI_API_KEY=your-api-key
AI_BASE_URL=https://your-provider.example/v1
AI_MODEL=your-model

TARGET_REPOSITORY=owner/site-repository
TARGET_REPO_TOKEN=your-fine-grained-token

SOURCE_URLS="https://source.example/feed.xml"
CONTENT_INSTRUCTIONS="Describe the audience, subject, and publication standard."
```

Then verify the repository and create the target site with baseline content:

```bash
bun run check
bun run initial
```

Run the normal pipeline with:

```bash
bun run run
```

Never commit `.env` or any API token. The checked-in `.env.example` contains no
working credentials.

## GitHub Actions

The `Generate and publish` workflow supports manual runs and
`repository_dispatch` events of type `publume-schedule`.

Store credentials as repository secrets:

- `AI_API_KEY`
- `TARGET_REPO_TOKEN`
- `DELIVERY_CONFIG` when notification channels are enabled

For the first `initial` run, `TARGET_REPO_TOKEN` must be scoped to the target site
repository with both Contents and Workflows read/write permission. See the
manual deployment guide before creating it.

Store non-secret configuration as repository variables. See
[Configuration](docs/configuration.md) for the complete list.

For first-time setup, repository creation, and Pages configuration, follow the
GitHub manual deployment guide in [English](docs/deployment.en.md) or
[简体中文](docs/deployment.md).

The optional Worker in [`scheduler/`](scheduler/) dispatches the workflow every
two hours. `GITHUB_TOKEN` must be configured as a Cloudflare Worker secret, and
`GITHUB_REPOSITORY` must be configured as a Worker environment variable.

## Themes and sites

Core does not contain Astro, layouts, styles, translations, or page components.
On the first `initial` run it fetches `THEME_REPOSITORY` at `THEME_REF`, copies its
shared site runtime, validates the selected `THEME`, and overlays that visual
theme into an empty target repository. The overlay owns its visual tokens in
`theme.css`; later runs only write article content and generated site identity
and behavior configuration.

The theme and target marker contracts are documented in
[Architecture](docs/architecture.md). Maintained themes belong in the separate
[`Publume/themes`](https://github.com/Publume/themes) repository.

Running the `Upgrade Publume Core` workflow synchronizes a requested Core
release into a managed repository while preserving its `state/` directory.
Running `Generate and publish` in `bootstrap` mode replaces the selected theme
while preserving generated articles. Both operations are designed for Publume
Cloud but remain available to self-hosted users. A successful first `initial`
run installs the theme, executes the content pipeline, and publishes at least
one validated article; it never reports an empty site as successfully ready.

## Development

```bash
bun run typecheck
bun test
bun run acceptance
```

The acceptance test creates a minimal theme and temporary Git repositories at
runtime, and uses local fixture sources plus a fake AI client. It never calls a
real AI provider or pushes to GitHub.

Prompt changes have a separate live evaluation that uses the configured AI
provider without collecting or publishing content. See
[Prompt evaluation](docs/prompt-eval.md) for its dataset, thresholds, and
evidence boundary.

To run the same acceptance flow against a local Publume Themes checkout:

```bash
PUBLUME_THEME_DIRECTORY=../themes bun run acceptance
```

To run the actual GitHub workflow locally, install Docker and
[act](https://github.com/nektos/act), configure `.env`, and run:

```bash
bun run action:local -- --initial
bun run action:local -- --bootstrap
bun run action:local -- --preview
```

Local Action runs write to `.local/site.git` and do not push decision state to a
remote repository. Preview requires the selected theme to provide a `dev` script.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Security
issues must follow [SECURITY.md](SECURITY.md), not the public issue tracker.

## License

Publume Core is licensed under the [Apache License 2.0](LICENSE).
