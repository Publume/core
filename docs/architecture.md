# Architecture

Publume separates content generation from site presentation and hosted control
plane concerns.

```text
Publume Core   -> collects, evaluates, generates, publishes, and delivers content
Publume Themes -> owns site implementations and presentation contracts
Publume Cloud  -> provisions and operates user-owned deployments
Publume Sites  -> user-owned output repositories and deployed websites
```

## Runtime path

`src/` has one dependency direction:

```text
cli
├── config
├── app/pipeline
│   ├── app/ports
│   └── domain
└── adapters
    ├── app/ports
    ├── config
    └── domain
```

- `domain/` owns content, decision, and candidate-selection rules. It has no
  knowledge of Git, HTTP providers, files, or command-line execution.
- `app/ports.ts` defines the external capabilities required by the pipeline:
  source reading, editorial decisions, decision storage, site publishing, and
  optional notification delivery.
- `app/pipeline.ts` owns the publishing use case and depends only on domain values,
  validated configuration, and those ports.
- `adapters/` implements the ports for OpenAI-compatible APIs, web sources, a JSON
  state file, Git, and a target site repository.
- `config/` owns the environment contract and produces a grouped, immutable
  runtime configuration.
- `cli.ts` is the composition root. It validates configuration, creates adapters,
  runs one pipeline invocation, and prints the summary.

The resulting runtime path is:

1. validate environment configuration;
2. read and normalize RSS, Atom, JSON, or HTML sources;
3. deduplicate, apply recency rules, and select the newest candidates;
4. evaluate candidates against a bounded recent-publication context and generate articles through the editorial port;
5. build and push the target site through the publishing port;
6. persist notification work before attempting configured delivery channels;
7. atomically persist bounded decisions, source checkpoints, and pending delivery work.

The process owns all temporary clones and removes them after success or failure.
There is no daemon, database, queue, or shared mutable service.

## Configuration boundary

Environment variables are the only runtime configuration source. Secrets are not
accepted through checked-in files in CI. Configuration is validated before any
source or AI request is made.

The AI boundary currently supports APIs compatible with OpenAI chat completions.
Provider names are labels; `AI_BASE_URL`, `AI_MODEL`, and the allowlist determine
the actual endpoint and model.

## Theme contract

A theme repository contains one or more themes under `themes/<theme-id>`.
Every theme root must include `.publume-theme.json`:

```json
{
  "schemaVersion": 1,
  "id": "editorial"
}
```

Core validates this marker before copying files. A bootstrapped target receives
`.publume-site.json`:

```json
{
  "schemaVersion": 1,
  "theme": "editorial"
}
```

Core refuses to bootstrap a non-empty repository without a compatible site
marker. This prevents accidental overwrites of user-owned repositories.

Theme dependency installation and build commands run without environment
variables whose names indicate credentials, keys, passwords, secrets, or tokens.
This is defense in depth, not a sandbox. Theme build scripts execute code with the
runner user's filesystem and network permissions. Only use reviewed and trusted
theme repositories and pin a reviewed release.

The theme must provide:

- a `package.json` with a `build` script;
- an optional `dev` script when local preview is supported;
- a writable `src/content/articles/` directory;
- support for `src/data/site-config.generated.json`;
- its own deployment workflow and ignored build output.

Core does not assume Astro or another specific static site generator.

Bootstrap mode is also the explicit theme-replacement boundary. If a compatible
target marker names a different theme, Core preserves generated articles,
removes files owned by the previous theme, installs the selected theme, rebuilds
the site, and commits the replacement. Normal content runs still fail closed on
a theme mismatch.

A theme may ship sample articles for standalone development. During bootstrap,
Core clears `src/content/articles/` and leaves only `.gitkeep`; generated
articles are the sole production content in that path.

## State and idempotence

`state/decisions.json` is the bounded source of prior decisions. A decision key
combines source identity, external identity, normalized content, and the current
generation configuration hash. The target site is also scanned for published
decision keys, so a lost local state file does not automatically republish
existing content.

Per-source checkpoints prevent a high-volume source from forcing future runs to
walk progressively older material. Failed sources and candidates do not advance
their checkpoints. The current editorial configuration fingerprint is persisted
with the state; when it changes, Core ignores old checkpoints for one run and
reconsiders only material that is still inside the configured age window.
Decision history is capped by `MAX_DECISION_RECORDS`.

Notification work is written to the same state file after the target repository
commit succeeds and before any channel request is attempted. A failed Telegram,
webhook, or email request therefore remains pending for the next scheduled run.
The queue is capped by `MAX_PENDING_DELIVERIES`; a full queue stops new
publication instead of silently dropping personal notifications. Delivery is
at-least-once because a process can stop after a provider accepts a request but
before the updated queue is persisted.
Removing a channel is an explicit request to discard its remaining pending
items; this prevents a retired endpoint from filling the bounded queue forever.

Exact candidate identity is checked before AI calls. The publication gate also
receives up to `DEDUPLICATION_CONTEXT_SIZE` recently approved titles and URLs,
allowing it to reject semantically duplicated coverage across different sources.
The context is bounded by both that setting and the decision-state retention cap.

## Failure semantics

- Invalid startup configuration fails before network access.
- One unavailable source is reported while other sources continue.
- One failed AI candidate does not stop unrelated candidates.
- AI output that fails schema, language, source, or unsafe-markup validation is
  rejected.
- A target build or push failure marks generated decisions as failed and exits
  unsuccessfully.
- A notification failure leaves a bounded pending item and does not roll back an
  already published article.
- A successful trigger may publish zero articles.

## Trust boundaries

Sources, AI responses, persisted state, theme markers, and target repositories are
untrusted inputs. Tokens are passed only to their intended network adapters and
must never appear in logs, fixtures, generated articles, or repository files.
