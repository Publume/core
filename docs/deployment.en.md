# Manual deployment on GitHub

**English** | [简体中文](deployment.md)

This guide deploys Publume directly on GitHub and Cloudflare without Publume Cloud. If you use Publume Cloud, Cloud creates,
configures, waits for, and verifies the same resources automatically; do not repeat this manual procedure.

A complete manual deployment contains three runtime resources that you own:

```text
Cloudflare Trigger Worker
          |
          | repository_dispatch: publume-schedule
          v
Core repository (private; stores configuration and run state)
          |
          | publishes the site and articles
          v
Website repository (public; builds and deploys GitHub Pages)
```

Create Core and Website and complete the first publication before deploying the Trigger Worker. The Worker is required for a
complete scheduled deployment, but it comes last so that it cannot trigger Core before the site is ready.

## Before you start

You need:

- GitHub and Cloudflare accounts;
- a working OpenAI Chat Completions-compatible endpoint, API key, and model name; the endpoint must support JSON Object
  response format;
- at least one reachable RSS, Atom, JSON, or HTML source containing an item published within the last 24 hours whose article
  URL is also reachable;
- local Git, Bun 1.3.14 or newer, and a browser for the final Worker deployment.

This guide targets a public Website repository deployed through GitHub Pages. The current Website workflow only builds a private
repository; it does not upload or deploy Pages, so a private Website is a build archive rather than a public site. Keep Core
private because it stores run state and site configuration. Store API keys and tokens only in Actions secrets or Cloudflare
Worker secrets.

## 1. Create your Core repository from the template

1. Open [`Publume/core`](https://github.com/Publume/core).
2. Click the green **Use this template** button.
3. Select **Create a new repository**.
4. Select your account as the Owner and enter a name such as `my-publume-core`.
5. Choose **Private** and leave **Include all branches** unchecked.
6. Click **Create repository from template**.

Use the repository template rather than a fork. You do not need to clone it yet; the local clone is only needed for the final
Worker deployment.

## 2. Create an empty Website repository and enable Pages

1. Click **+** in the top-right corner of GitHub and select **New repository**.
2. Use the same Owner as Core and enter a site repository name such as `my-publume-site`.
3. Choose **Public**.
4. Do not add a README, `.gitignore`, or license; this repository must be empty.
5. After creating it, open **Settings → Pages**.
6. Under **Build and deployment → Source**, select **GitHub Actions**.

The first Core `initial` run writes the complete site, at least one validated article, and the Pages workflow into this empty
repository. If it already contains ordinary files and has no `.publume-site.json`, Core refuses to overwrite it.

Your Pages URL is normally:

```text
https://YOUR-USERNAME.github.io/my-publume-site/
```

If the Website repository is named `YOUR-USERNAME.github.io`, the URL is `https://YOUR-USERNAME.github.io/` instead.

## 3. Create a token that can only write to Website

1. Open your GitHub account settings and go to
   **Developer settings → Personal access tokens → Fine-grained tokens**.
2. Click **Generate new token** and set a reasonable expiration date.
3. Under **Repository access**, select **Only select repositories**, then select only the new Website repository.
4. Under **Repository permissions**, set **Contents** to **Read and write**.
5. Set **Workflows** to **Read and write** as well. The first `initial` run writes
   `.github/workflows/pages.yml`; GitHub rejects that push without this permission.
6. Create the token and copy it immediately. GitHub does not show it again.

These settings match GitHub's permissions for writing workflow files. Organization-owned repositories may require an
administrator to approve a fine-grained token. An unapproved token cannot clone or push to the target repository.

## 4. Configure Core

Open your Core repository and go to **Settings → Secrets and variables → Actions**.

Add these values on the **Secrets** tab:

| Name | Value |
| --- | --- |
| `AI_API_KEY` | The API key for the AI service. |
| `TARGET_REPO_TOKEN` | The fine-grained token created in step 3. |

Add the first-run configuration on the **Variables** tab:

| Name | Example or description |
| --- | --- |
| `AI_PROVIDER` | `openai-compatible`; this is the provider label. |
| `AI_BASE_URL` | The Chat Completions API root, such as `https://api.openai.com/v1`; do not include `/chat/completions`. |
| `AI_MODEL` | A model ID that the configured endpoint actually supports. |
| `TARGET_REPOSITORY` | `YOUR-USERNAME/my-publume-site`; do not enter a web URL. |
| `SOURCE_URLS` | Real source URLs, one per line. |
| `CONTENT_INSTRUCTIONS` | Describe the audience, subject, exclusions, and publication standard. |
| `SITE_URL` | The complete Pages URL from step 2; project sites must keep the repository path and trailing `/`. |

The default theme is `editorial`, so the first deployment does not need a `THEME` variable. These optional values set the site
language and name immediately:

| Name | Example |
| --- | --- |
| `OUTPUT_LANGUAGES` | `en` |
| `DEFAULT_CONTENT_LANGUAGE` | `en` |
| `SITE_LOCALE` | `en` |
| `SITE_NAME` | Your site name |

Do not add notifications, replace the theme, or tune thresholds during the first deployment. After all three resources work,
use [Configuration](configuration.md) for `DELIVERY_CONFIG`, themes, languages, prompts, and publication thresholds.

## 5. Run `initial` once

1. Open **Actions** in Core.
2. Select **Generate and publish** in the left sidebar.
3. Click **Run workflow**.
4. Select the `main` branch and choose `initial` for **Run mode**.
5. Click the green **Run workflow** button and wait for the run to finish.

A successful first publication must meet every condition:

1. **Generate and publish** is green in Core;
2. its summary contains a non-empty `targetCommitSha` and `published` is at least `1`;
3. Website contains a `content: publish validated articles` commit with generated article files;
4. **Deploy site** is green in Website;
5. the URL under **Settings → Pages** opens and its assets load correctly.

GitHub documents that a Pages change can take up to about 10 minutes to become available. A green Core workflow proves content
generation and publication, not a live website; always check Website's **Deploy site** workflow and final URL.

`initial` fails explicitly when no article passes validation, so an empty site cannot be reported as ready. Correct the source,
model, or publication instructions before retrying.

## 6. Deploy the Cloudflare Trigger Worker

Start this section only after every check in step 5 succeeds. The Worker sends a `publume-schedule` event to Core every two
hours. Core handles that event as a normal `run`.

First create a separate fine-grained token for the Worker:

1. Under **Repository access**, select only the Core repository.
2. Set **Contents** to **Read and write**.
3. Create the token and copy it immediately.

Now clone your Core repository locally:

```bash
git clone https://github.com/YOUR-USERNAME/my-publume-core.git
cd my-publume-core
```

If cloning the private repository asks for a password, enter your GitHub username and use the new Worker token in the password
field. Do not enter your GitHub account password.

Create an untracked `.env.scheduler` in the Core repository root:

```env
GITHUB_TOKEN=YOUR-WORKER-TOKEN
```

Log in to Cloudflare and deploy:

```bash
bunx wrangler@4.119.0 login
bunx wrangler@4.119.0 deploy \
  --config scheduler/wrangler.toml \
  --var "GITHUB_REPOSITORY:YOUR-USERNAME/my-publume-core" \
  --secrets-file .env.scheduler
```

Delete `.env.scheduler` immediately after deployment. The repository ignores it through `.gitignore`, but it should not remain
on disk.

The Worker has no public web page. A complete Worker deployment meets every condition:

1. Cloudflare contains the `publume-scheduler` Worker;
2. it shows the Cron Trigger `0 */2 * * *`;
3. after the next Cron invocation, Core contains a **Generate and publish** run triggered by `repository_dispatch`;
4. that run uses normal `run` semantics and finishes normally, even when its summary says `published: 0`.

The first two checks prove that Worker and Cron are installed. The last two prove the real Cloudflare-to-GitHub trigger path.
Cloudflare Cron uses UTC. `0 */2 * * *` runs on even UTC hours; it is not a two-hour interval measured from deployment time.
Cloudflare notes that a new or updated Cron can take up to 15 minutes to propagate, so check Core after the next valid trigger.

## 7. Run Publume after deployment

- Scheduled run: the Worker sends `publume-schedule`; no manual action is required.
- Immediate run: choose `run` in Core's **Generate and publish** workflow.
- Theme replacement: update `THEME`, then intentionally choose `bootstrap` once; it preserves generated articles.
- Do not reuse `initial`: it is only for the first publication into a new, empty Website repository.

`published: 0` can be a successful normal `run`; it means that no new item met the publication standard.

## Completion checklist

| Resource | Completion evidence |
| --- | --- |
| Core | `initial` succeeds with `targetCommitSha` and `published >= 1`. |
| Website | It contains an article commit, **Deploy site** succeeds, and its Pages URL opens. |
| Trigger Worker | Worker and Cron exist and have caused a real `repository_dispatch` run. |

The manual deployment is complete only when all three rows pass.

## Common failures

| Symptom | Cause and fix |
| --- | --- |
| `Target fetch failed` or HTTP 403 | Confirm that `TARGET_REPO_TOKEN` selects Website and has Contents and Workflows Read and write. Confirm approval for organization tokens. |
| `Target repository is non-empty and has no compatible .publume-site.json` | Website was initialized. Recreate it without a README, `.gitignore`, or license. |
| Website builds but has no Pages deployment | The workflow only builds private repositories. Use a public Website for a public site and set Pages Source to GitHub Actions. |
| A Website Pages step reports a missing site or 404 | In Website, set **Settings → Pages → Source** to **GitHub Actions**, then rerun **Deploy site**. |
| The final Core `git push` returns 403 | A repository or organization policy blocks Actions from writing contents. Check **Settings → Actions → General** and `main` branch protection. |
| Website has an article commit, but Core failed only at `Persist decision state` | Do not delete Website or recreate the site. Fix Core's Actions write permission, then continue with a normal `run`; verify both repositories afterward. |
| The site opens but asset paths are broken | `SITE_URL` is missing the project path. Use a URL such as `https://owner.github.io/repository/`, then run once in `run` mode. |
| `initial` reports that no article passed validation | Check source reachability and freshness, model output, and `CONTENT_INSTRUCTIONS`; do not treat the failure as an empty-site success. |
| Worker deploys but never triggers Core | Check the Worker Cron, `GITHUB_REPOSITORY`, Worker secret `GITHUB_TOKEN`, and whether the token selects the correct Core repository with Contents Read and write. |
| A normal workflow succeeds with no new article | This is not necessarily an error. Check sources, `MAX_ITEM_AGE_HOURS`, `PUBLISH_THRESHOLD`, and filter counters in the summary. |
