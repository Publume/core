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
2. resolve standard Feed URLs or configured `rsshub://` routes, then normalize RSS, Atom, JSON, or HTML indexes;
3. merge equal canonical URLs, apply recency/processed-state rules, run bounded discovery admission, and balance sources and categories;
4. fetch linked article pages only for selected candidates, retaining the source summary when full text is unavailable;
5. consolidate reports of the same actors, event, and time frame into exhaustive, non-overlapping story groups;
6. when the fixed profile permits it and evidence is below its minimum, query one configured search Feed and fetch only the bounded results;
7. extract claim-level evidence, material uncertainty, and exact source references through the publication gate;
8. generate the fixed profile's Story Blocks for every language, validate every claim/source mapping, and deterministically render Markdown;
9. build and push the target site through the publishing port;
10. persist notification work before attempting configured delivery channels;
11. atomically persist bounded decisions, processed candidates, safe source checkpoints, and pending delivery work.

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

A theme repository contains one shared static-site runtime under `shared/` and
one or more visual overlays under `themes/<theme-id>`. Every overlay root must
include `.publume-theme.json`:

```json
{
  "schemaVersion": 1,
  "id": "editorial"
}
```

Core copies `shared/`, validates the selected marker, then overlays the selected
theme. A bootstrapped target receives
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

The shared runtime must provide:

- a `package.json` with a `build` script;
- an optional `dev` script when local preview is supported;
- a writable `src/content/articles/` directory;
- support for `src/data/site-config.generated.json`;
- a deployment workflow and ignored build output;
- the only interface translation catalog and all language-aware routes.

Each visual overlay provides `Shell.astro`, `Home.astro`, `Article.astro`, and
`theme.css` under `src/theme/`. It does not duplicate routes, feeds,
translations, build configuration, or dependencies.

Core does not assume Astro or another specific static site generator.

Bootstrap mode is the explicit theme-replacement boundary. If a compatible
target marker names a different theme, Core preserves generated articles,
removes files owned by the previous theme, installs the selected theme, rebuilds
the site, and commits the replacement. Normal content runs still fail closed on
a theme mismatch.

A theme may ship sample articles for standalone development. During initial deployment,
Core clears those examples before writing any validated generated articles. The generated
article directory remains empty when nothing passes validation; later runs remain its sole
content owner.

Published article frontmatter keeps human-readable topic labels together with
deterministic topic IDs. Themes use the IDs for stable archive URLs while older
articles that contain labels only remain readable during theme upgrades.

## State and idempotence

`state/decisions.json` is the bounded source of prior decisions. A decision key
combines source identity, external identity, normalized content, and the current
generation configuration hash. The target site is also scanned for published
decision keys, so a lost local state file does not automatically republish
existing content.

Canonical reports are merged before article fetches. A bounded discovery model
scores only titles and feed excerpts; source/category caps prevent one noisy feed
from consuming the run. Budget-deferred candidates remain unprocessed in durable
state and are reconsidered on later runs. Per-source checkpoints advance only
through an observed publication timestamp when that source has no deferred or
failed candidate, so a successful run cannot silently skip backlog. The current editorial configuration fingerprint is persisted
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
allowing it to reject semantically duplicated coverage across different runs.
Core snapshots that historical context before evaluating the current run. Reports
from the same current event are first merged by the consolidator, then the
remaining story gates and article generations run with the bounded
`AI_CONCURRENCY` setting. Results are applied in story order, so network timing
cannot reorder decisions or generated files. The historical context is bounded
by both the deduplication setting and the decision-state retention cap.

## Evidence and report consolidation

Source indexes and article pages have different roles. RSS, Atom, JSON, and HTML
indexes discover candidates. Only candidates that survive deterministic selection
can trigger a request to their canonical article URL. A successful article-page
parse replaces the short source summary as evidence; a failed fetch is recorded
and the original summary remains visible only as discovery context. A summary
cannot support a verified fact or appear in the approved source set, and a story
with no readable article page is rejected before the AI gate.

Production article fetches reject credential-bearing or non-HTTP URLs, resolve
every hostname before each request and redirect, and reject the URL when any DNS
answer is not a public IP address. Each article response is streamed with a 4 MB
limit before the extracted evidence is reduced to the prompt-size limit.

The editorial consolidator receives the selected reports once per run. Its output
must place every input report index in exactly one group, with no missing,
duplicated, or invented index. Reports merge only when they describe the same
underlying event in the same time frame. Follow-ups, opinions, similarly named
products, and broad topic matches remain separate. Invalid consolidation output
fails the run before publication instead of silently losing a report.

Each story gate returns claims with stable IDs and exact supporting URLs, plus
structured uncertainties and their claim/source references. Every URL must belong
to a fetched report in that story, and the story-level source set must equal the
claim-level union. Generation returns only the fixed profile's ordered Story
Blocks. Required blocks appear exactly once; optional blocks appear only when
distinct supplied evidence supports them. Runtime validation rejects duplicate
or out-of-order blocks, missing required blocks, unknown claim IDs, missing claim
mappings, incorrect block source sets, enrichment evidence in a block without
the configured tool permission, language drift, or raw HTML. Core then joins
block Markdown for the version 1 Theme contract.

This is source-bounded evidence checking, not an independent truth oracle. Core
can compare supplied reports and prevent unsupported synthesis; it cannot prove
that a source itself is honest, authenticate documents outside the fetched pages,
or replace human review for high-stakes claims.

## Failure semantics

- Invalid startup configuration fails before network access.
- One unavailable source is reported while other sources continue.
- All configured sources failing makes the run fail; healthy empty sources produce `noop`.
- One unavailable article page falls back to its discovered source summary and is reported separately.
- Invalid report consolidation fails closed before any story is published.
- One failed AI candidate does not stop unrelated candidates.
- AI output that fails schema, language, source, or unsafe-markup validation is
  rejected.
- A target build or push failure marks generated decisions as failed and exits
  unsuccessfully.
- A notification failure leaves a bounded pending item and does not roll back an
  already published article.
- A successful trigger may publish zero articles.
- Returned summaries distinguish `success`, `partial`, and `noop` and include actual model-call provenance.

## Trust boundaries

Sources, AI responses, persisted state, theme markers, and target repositories are
untrusted inputs. Tokens are passed only to their intended network adapters and
must never appear in logs, fixtures, generated articles, or repository files.
