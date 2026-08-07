# Manual deployment on GitHub

**English** | [简体中文](deployment.md)

This guide deploys Publume Core directly on GitHub without Publume Cloud. A first deployment uses two repositories:

```text
Your Core repository (private; stores configuration and run state)
        |
        v
Your Website repository (public; stores the site and deploys GitHub Pages)
```

Follow the steps in order. Do not configure scheduling or start with a normal `run` before the first deployment succeeds.

## Before you start

You need:

- a GitHub account;
- a working OpenAI Chat Completions-compatible endpoint, API key, and model name;
- at least one reachable RSS, Atom, JSON, or HTML source.

GitHub Free supports Pages for public repositories. A private Website repository requires a GitHub plan that supports private
Pages. The Core repository should be private because it stores run state and site configuration. API keys and tokens must only
be stored as Actions secrets.

## 1. Create your Core repository from the template

1. Open [`Publume/core`](https://github.com/Publume/core).
2. Click the green **Use this template** button.
3. Select **Create a new repository**.
4. Select your account as the Owner and enter a repository name such as `my-publume-core`.
5. Choose **Private** and leave **Include all branches** unchecked.
6. Click **Create repository from template**.

You must use the repository template. Do not fork it, and do not start by cloning it locally.

## 2. Create an empty Website repository and enable Pages

1. Click **+** in the top-right corner of GitHub and select **New repository**.
2. Use the same Owner as Core and enter a site repository name such as `my-publume-site`.
3. Choose **Public**.
4. Do not add a README, `.gitignore`, or license; this repository must be empty.
5. After creating it, open **Settings → Pages**.
6. Under **Build and deployment → Source**, select **GitHub Actions**.

The first Core `initial` run writes the complete site, baseline content, and its Pages workflow into this empty repository. If the repository already
contains ordinary files and has no `.publume-site.json`, Core refuses to overwrite it.

Your Pages URL is normally:

```text
https://YOUR-USERNAME.github.io/my-publume-site/
```

If the Website repository is named `YOUR-USERNAME.github.io`, the URL is `https://YOUR-USERNAME.github.io/` instead.

## 3. Create a token that can only write to the Website repository

1. Open your GitHub account settings and go to
   **Developer settings → Personal access tokens → Fine-grained tokens**.
2. Click **Generate new token** and set a reasonable expiration date.
3. Under **Repository access**, select **Only select repositories**, then select only the new Website repository.
4. Under **Repository permissions**, set **Contents** to **Read and write**.
5. Set **Workflows** to **Read and write** as well. The first `initial` run writes
   `.github/workflows/pages.yml`; GitHub rejects that push without this permission.
6. Create the token and copy it immediately. GitHub does not show it again.

Organization-owned repositories may require an administrator to approve a fine-grained token. An unapproved token cannot clone
or push to the target repository.

## 4. Configure the Core repository

Open your Core repository and go to **Settings → Secrets and variables → Actions**.

Add these values on the **Secrets** tab:

| Name | Value |
| --- | --- |
| `AI_API_KEY` | The API key for the AI service. |
| `TARGET_REPO_TOKEN` | The fine-grained token created in step 3. |

Notifications are not required for the first deployment and can be skipped. When needed, follow "Configure notifications"
later in this section to add `DELIVERY_CONFIG`.

Add at least these values on the **Variables** tab:

| Name | Example or description |
| --- | --- |
| `AI_PROVIDER` | `openai-compatible`. This is the provider label. |
| `AI_BASE_URL` | The Chat Completions API root, for example `https://api.openai.com/v1`. Do not include `/chat/completions`. |
| `AI_MODEL` | A model ID that the configured endpoint actually supports. |
| `TARGET_REPOSITORY` | `YOUR-USERNAME/my-publume-site`; do not enter a web URL. |
| `SOURCE_URLS` | Real source URLs, one per line. |
| `CONTENT_INSTRUCTIONS` | Describe the audience, subject, exclusions, and publication standard. |
| `SITE_URL` | The complete Pages URL from step 2. Project sites must keep the repository path and trailing `/`. |
| `THEME` | The site template ID, such as `editorial`; see the complete list below. |

These optional variables make the first page use the intended language and site name immediately:

| Name | Example |
| --- | --- |
| `OUTPUT_LANGUAGES` | `en` |
| `DEFAULT_CONTENT_LANGUAGE` | `en` |
| `SITE_LOCALE` | `en` |
| `SITE_NAME` | Your site name |

### Choose a site template

`THEME` selects the site template installed by the first `initial` run. It defaults to `editorial`. The current
[`Publume/themes`](https://github.com/Publume/themes) repository provides:

| `THEME` value | Best suited for |
| --- | --- |
| `editorial` | News, analysis, and general publishing with fast, clear reading. |
| `journal` | Long-form and magazine publishing with warm typography. |
| `briefing` | Dense intelligence feeds and rapid scanning. |
| `terminal` | AI, developer, cloud, and security updates. |
| `ledger` | Markets, business, crypto, and energy. |
| `atlas` | World, climate, geography, and travel coverage. |
| `laboratory` | Science, health, robotics, and research notes. |
| `orbit` | Space, defense, mobility, and robotics. |
| `studio` | Design, culture, and consumer technology. |
| `arcade` | Games, gadgets, and digital culture. |
| `scoreboard` | Sports, rankings, match-day, and mobility coverage. |
| `table` | Food, travel, and culture. |

The official template repository normally needs no additional variables. Add these only when you need to pin or replace the
source:

| Name | Default | Purpose |
| --- | --- | --- |
| `THEME_REPOSITORY` | `Publume/themes` | The source template repository. |
| `THEME_REF` | `main` | A branch, tag, or commit-like fetch ref in the template repository. |

To change the template later, update `THEME`, then intentionally run `bootstrap` once. Core preserves generated articles while
replacing the template; a normal `run` never changes it.

### Configure notifications (optional)

Notification configuration and credentials must be stored under
**Settings → Secrets and variables → Actions → Secrets** in the Core repository:

1. Click **New repository secret**.
2. Enter `DELIVERY_CONFIG` as the Name.
3. Enter one JSON array as the Secret; every object in the array is one notification channel.
4. Save it, then perform a normal `run`. Never store this JSON as a Variable or commit it to the repository.

For example, send every published article to Telegram and Discord:

```json
[
  {
    "id": "personal-telegram",
    "type": "telegram",
    "botToken": "123456789:YOUR_BOT_TOKEN",
    "chatId": "123456789"
  },
  {
    "id": "team-discord",
    "type": "discord",
    "webhookUrl": "https://discord.com/api/webhooks/YOUR_WEBHOOK"
  }
]
```

Every `id` must be unique and remain stable. It may contain only letters, digits, periods, underscores, and hyphens. Supported
channel configurations are:

| `type` | Required fields | Notes |
| --- | --- | --- |
| `telegram` | `botToken`, `chatId` | `chatId` can be a numeric ID or `@channel_name`; the bot must be allowed to send messages. |
| `discord` | `webhookUrl` | The complete HTTPS Discord Incoming Webhook URL. |
| `slack` | `webhookUrl` | The complete HTTPS Slack Incoming Webhook URL. |
| `feishu` | `webhookUrl`; optional `signingSecret` | A Feishu custom-bot webhook; provide the secret when signature verification is enabled. |
| `dingtalk` | `webhookUrl`; optional `signingSecret` | A DingTalk custom-bot webhook; provide the secret when signing is enabled. |
| `wecom` | `webhookUrl` | A WeCom group-bot webhook. |
| `ntfy` | `topicUrl` | A complete HTTPS topic URL, such as `https://ntfy.sh/your-private-topic`. |
| `matrix` | `homeserver`, `roomId`, `accessToken` | The homeserver must use HTTPS and the account must be able to send to the room. |
| `resend` | `apiKey`, `from`, `to` | `from` is a verified sender; `to` is an array containing 1–20 email addresses. |
| `webhook` | `url`; optional `headers` | A generic HTTPS webhook; `headers` is a string-to-string object for authentication headers. |

Core calculates the platform-specific Feishu or DingTalk signature when `signingSecret` is configured. If a bot instead uses a keyword
security rule, that keyword must occur in the article title or summary. WeCom bots must accept an ordinary text request. To disable all
notifications, delete `DELIVERY_CONFIG` or set it to `[]`.

Notifications are sent after `initial` or a normal `run` publishes a new article. `bootstrap` and runs with no new article send nothing.
Check the run summary afterward:

- `deliveriesSent`: notifications successfully sent in this run;
- `deliveriesFailed`: notification attempts that failed in this run;
- `deliveriesPending`: notifications still waiting for a later retry.

A fully successful notification run has `deliveriesSent > 0`, `deliveriesFailed = 0`, and `deliveriesPending = 0`. A delivery
failure does not roll back an already published article; Core persists the pending item and retries it during the next `run`.

All other variables have defaults. See [Configuration](configuration.md) for thresholds, prompts, delivery, and multilingual
settings.

## 5. Run `initial` once

1. Open **Actions** in the Core repository.
2. Select **Generate and publish** in the left sidebar.
3. Click **Run workflow**.
4. Select the `main` branch and choose `initial` for **Run mode**.
5. Click the green **Run workflow** button and wait for the run to finish.

A successful first deployment must meet all four conditions:

1. **Generate and publish** is green in the Core repository;
2. its run summary contains a non-empty `targetCommitSha` and `published` is at least `1`;
3. the Website repository contains a `content: publish validated articles` commit with generated article files;
4. **Deploy site** is green in the Website repository, and the URL shown under **Settings → Pages** opens successfully.

The first Pages deployment can take a minute or two. A successful Core workflow alone does not prove that the website is live;
always check **Deploy site** in the Website repository as well.

## 6. Generate content manually

After the first site deployment succeeds, return to **Generate and publish** in the Core repository and run it again with
**Run mode** set to `run`. A normal run reads the real sources, calls the AI endpoint, and publishes only content that passes the
filters and score threshold.

`published: 0` can still be a successful normal run: no new item met the publication standard. In `initial`, zero validated
articles is an explicit failure so an empty site cannot be reported as ready. Use `bootstrap`, not `initial`, for an intentional
theme replacement.

## Common failures

| Symptom | Cause and fix |
| --- | --- |
| `Target fetch failed` or HTTP 403 | Confirm that `TARGET_REPO_TOKEN` selects the Website repository and has Contents and Workflows Read and write. For organization tokens, confirm approval. |
| `Target repository is non-empty and has no compatible .publume-site.json` | The Website repository was initialized. Recreate it without a README, `.gitignore`, or license. |
| A Website Pages step reports a missing site or 404 | In the Website repository, set **Settings → Pages → Source** to **GitHub Actions**, then rerun **Deploy site**. |
| The final Core `git push` returns 403 | A repository or organization policy blocks Actions from writing contents. Check **Settings → Actions → General** and the `main` branch protection rules. |
| The site opens but asset paths are broken | `SITE_URL` is missing the project path. Use a URL such as `https://owner.github.io/repository/`, then run once in `run` mode. |
| The workflow succeeds with no new article | This is not necessarily an error. Check source freshness, `MAX_ITEM_AGE_HOURS`, `PUBLISH_THRESHOLD`, and the filter counters in the run summary. |

## Optional: run automatically every two hours

Finish the manual flow first. You can then deploy the Cloudflare Worker under `scheduler/`, which sends a `publume-schedule`
event to the Core repository every two hours.

Create a separate fine-grained token for the Scheduler. Select only the Core repository and grant
**Contents: Read and write**. In the local Core repository root, create an untracked `.env.scheduler` file:

```env
GITHUB_TOKEN=YOUR-SCHEDULER-TOKEN
```

Then run:

```bash
bunx wrangler@4.119.0 login
bunx wrangler@4.119.0 deploy \
  --config scheduler/wrangler.toml \
  --var "GITHUB_REPOSITORY:YOUR-USERNAME/my-publume-core" \
  --secrets-file .env.scheduler
```

Delete `.env.scheduler` locally after deployment. The repository ignores it through `.gitignore`, but it should not remain on
disk. The Scheduler has no public web page. It is working when Cloudflare shows the `publume-scheduler` Worker and Cron Trigger,
and the next trigger creates a **Generate and publish** run in Core with the `repository_dispatch` event.
