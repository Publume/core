# Configuration

Publume Core reads configuration from environment variables. Bun also loads a
local `.env` file automatically; GitHub Actions should use repository variables
and secrets instead.

## Required secrets

| Name | Purpose |
| --- | --- |
| `AI_API_KEY` | Authenticates the configured AI endpoint. |
| `TARGET_REPO_TOKEN` | Writes to a GitHub target repository. Not required for local filesystem targets. |
| `DELIVERY_CONFIG` | Optional JSON array containing notification endpoints and their credentials. |

Use a fine-grained GitHub token with access only to the selected target
repository. It needs **Contents: Read and write** for every publication and
**Workflows: Read and write** when the initial run installs the target repository's
Pages workflow. After the initial deployment, a self-hosted operator can rotate to a
Contents-only token if future runs will never replace the theme or reinstall
the site workflow.

## AI endpoint

| Name | Required | Default | Purpose |
| --- | --- | --- | --- |
| `AI_PROVIDER` | yes | - | Provider label used in decision identity. |
| `AI_BASE_URL` | yes | - | Base URL of an OpenAI-compatible API. |
| `AI_MODEL` | yes | - | Model used for gating and generation. |
| `AI_ALLOWED_MODELS` | no | `AI_MODEL` | Comma- or newline-separated model allowlist. |
| `AI_RESPONSE_FORMAT` | no | `json_object` | `json_object` or `json_schema`. |
| `AI_TIMEOUT_SECONDS` | no | `60` | Per-request timeout from 1 to 600 seconds. |
| `AI_CONCURRENCY` | no | `4` | Maximum concurrent gate or article-generation requests, from 1 to 20. |

Transient timeouts and HTTP 429, 502, or 503 responses are retried twice. Core
does not silently switch models. Every logical call reports the requested and
actual response model, attempt count, status, and available token usage in
`modelCalls`. Invalid JSON/schema output receives one representation-only repair
request; evidence and domain validation failures are never repaired into success.

## Content mission

| Name | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SITE_TYPE` | no | `general` | Publishing task fixed by Cloud during deployment; Core never routes individual articles between profiles. |
| `SOURCE_URLS` | yes | - | Comma- or newline-separated RSS, Atom, JSON, HTML URLs, or `rsshub://` routes. |
| `RSSHUB_BASE_URL` | for `rsshub://` | - | HTTPS base URL of a self-hosted or trusted RSSHub instance. Core resolves routes through this one endpoint. |
| `ENRICHMENT_SEARCH_URL_TEMPLATE` | no | - | HTTPS RSS/Atom/JSON/HTML search endpoint with one `{query}` placeholder. Used only when the fixed profile allows `web-search` and evidence is below its minimum. |
| `CONTENT_INSTRUCTIONS` | yes | - | Audience, topic, exclusions, and editorial standard. |
| `GATE_PROMPT` | no | built in | Publication decision instructions. |
| `ARTICLE_PROMPT` | no | built in | Article generation instructions. |
| `OUTPUT_LANGUAGES` | no | `en` | Comma- or newline-separated language tags. |
| `DEFAULT_CONTENT_LANGUAGE` | no | first output language | Language shown at the site root; it must be included in `OUTPUT_LANGUAGES`. |
| `PUBLISH_THRESHOLD` | no | `0.75` | Minimum gate score from 0 to 1. |
| `DEDUPLICATION_CONTEXT_SIZE` | no | `50` | Recent approved items supplied to the AI gate for semantic duplicate detection; `0` disables this context. |
| `MAX_ITEM_AGE_HOURS` | no | `24` | Maximum candidate age. |
| `MAX_CANDIDATES_PER_RUN` | no | `20` | Candidate budget after bounded AI admission and source/category balancing. Deferred candidates remain eligible for later runs. |
| `MINIMUM_CONTENT_LENGTH` | no | `80` | Minimum normalized candidate content length. |
| `SOURCE_TIMEOUT_SECONDS` | no | `20` | Per-source timeout from 1 to 300 seconds. |

Profiles and prompts are part of the decision identity. Changing the model, languages,
threshold, deduplication context size, audience instructions, or prompts allows
previously rejected source material to be evaluated under the new configuration.

The built-in profiles describe publishing tasks, not subjects. AI, finance,
games, health, and other interests belong in sources and `CONTENT_INSTRUCTIONS`.
Choose `general` when a site mixes subjects or no specialized task fits.

| Profile | Best suited source websites |
| --- | --- |
| `general` | A mixed collection of news sites, blogs, official feeds, and other sources. |
| `briefing` | Frequently updated news, industry-wire, announcement, and service-status sites. |
| `analysis` | In-depth media, think tanks, specialist publications, and contrasting coverage. |
| `explainer` | Professional blogs, engineering write-ups, case studies, and long-form explainers. |
| `research-review` | Journals, preprint servers, university labs, research institutes, and benchmark publishers. |
| `risk-advisory` | Security advisories, incident pages, recall notices, and official risk alerts. |
| `policy-tracker` | Government gazettes, regulators, legislatures, courts, and policy trackers. |
| `market-intelligence` | Investor-relations pages, exchange disclosures, industry media, pricing, and supply-chain publications. |
| `product-update` | Changelogs, release notes, vendor blogs, app platforms, and GitHub Releases. |

Each profile owns discovery priorities, minimum evidence, ordered Story Blocks,
optional evidence-dependent blocks, and enrichment budgets. User instructions
and prompt overrides refine one fixed profile rather than selecting a profile
per candidate. Generated claims carry source references, and every Story Block
must map back to those claim/uncertainty IDs. Core joins validated block Markdown
deterministically so version 1 Themes keep their existing article-body contract.

## Target and state

| Name | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TARGET_REPOSITORY` | yes | - | `owner/repository`, Git URL, or local repository path. |
| `TARGET_BRANCH` | no | `main` | Branch written by Core. |
| `STATE_PATH` | no | `state/decisions.json` | Persistent decision state file. |
| `MAX_DECISION_RECORDS` | no | `1000` | Maximum retained decision records. |
| `MAX_PENDING_DELIVERIES` | no | `500` | Maximum queued notification deliveries before new publication stops. |

## Delivery channels

`DELIVERY_CONFIG` is a JSON array stored as one secret. An empty array disables
notifications without changing publishing. Every channel needs a stable, unique
`id`; it is used to retry failures without regenerating an article.

```json
[
  {
    "id": "personal-telegram",
    "type": "telegram",
    "botToken": "...",
    "chatId": "..."
  },
  {
    "id": "team-discord",
    "type": "discord",
    "webhookUrl": "https://discord.com/api/webhooks/..."
  }
]
```

Core currently supports `telegram`, `discord`, `slack`, `feishu`, `dingtalk`,
`wecom`, `ntfy`, `matrix`, `resend`, and generic `webhook` channels. HTTP
endpoints must use HTTPS. Resend has a free quota but remains an external
provider; the other hosted services may also enforce their own fair-use limits.
Feishu and DingTalk accept an optional `signingSecret`; when present, Core adds
the platform-specific timestamp and HMAC signature to every request.
Never store this JSON as a repository variable or commit it to a file.

## Theme source

| Name | Required | Default | Purpose |
| --- | --- | --- | --- |
| `THEME_REPOSITORY` | no | `Publume/themes` | Theme Git repository or local repository path. |
| `THEME_REF` | no | `main` | Branch, tag, or commit-like fetch ref. Pin a release for reproducibility. |
| `THEME` | no | `editorial` | Theme directory name under `themes/`. |

## Site configuration

The following values are written to `src/data/site-config.generated.json` in the
target repository:

| Name | Default |
| --- | --- |
| `SITE_URL` | empty |
| `SITE_NAME` | empty; Themes supplies a localized default |
| `SITE_DESCRIPTION` | empty; Themes supplies a localized default |
| `SITE_TAGLINE` | empty; Themes supplies a localized default |
| `SITE_LOCALE` | default content language |
| `SITE_PUBLISHER_NAME` | site name |
| `SITE_AUTHOR_NAME` | site name |
| `SITE_CONTACT_URL` | empty |
| `SITE_AI_DISCLOSURE` | empty; Themes supplies a localized default |
| `SITE_SOCIAL_IMAGE_URL` | empty |
| `SITE_NEWSLETTER_URL` | empty |
| `SITE_SPONSOR_URL` | empty |
| `SITE_SHOW_TOPICS` | `true` |
| `SITE_SHOW_SCORE` | `false` |
| `SITE_SHOW_SOURCES` | `true` |
| `SITE_FOOTER_TEXT` | empty; Themes supplies a localized default |

`SITE_URL` should be the final public origin, such as `https://example.com`. It
enables canonical URLs, social metadata, and sitemap generation. The selected
theme owns its colors, layout width, and component geometry in `theme.css`;
Core validates the remaining URLs, locale tags, and booleans before publishing.
