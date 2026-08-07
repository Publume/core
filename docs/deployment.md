# GitHub 手动部署

[English](deployment.en.md) | **简体中文**

这份教程用于不经过 Publume Cloud、直接在 GitHub 和 Cloudflare 上部署 Publume。使用 Publume Cloud 时，Cloud
会自动完成同样的资源创建、配置、等待和验证，不需要再执行本教程。

一次完整的手动部署包含三个由你拥有的运行资源：

```text
Cloudflare Trigger Worker
          |
          | repository_dispatch: publume-schedule
          v
Core 仓库（私有，保存配置和运行状态）
          |
          | 发布站点和文章
          v
Website 仓库（公开，构建并部署 GitHub Pages）
```

请按顺序完成 Core、Website 和首次发布，确认网页可以打开后再部署 Trigger Worker。Worker 是完整部署的一部分，
但必须放在最后，避免站点尚未就绪时定时触发 Core。

## 准备

你需要：

- GitHub 账号和 Cloudflare 账号；
- 可用的 OpenAI Chat Completions 兼容接口、API Key 和模型名；接口必须支持 JSON Object 响应格式；
- 至少一个确认可以访问的 RSS、Atom、JSON 或 HTML 信息源，其中要有最近 24 小时内发布且正文链接可访问的内容；
- 在最后部署 Worker 时使用的本地 Git、Bun 1.3.14 或更高版本，以及浏览器。

本教程以公开 Website 仓库和 GitHub Pages 为目标。当前 Website Workflow 对私有仓库只执行构建，不上传或部署
Pages，因此私有 Website 只能作为构建归档，不能按本教程得到公开站点。Core 仓库建议设为私有，因为它会保存
运行状态和站点配置。API Key 和 Token 只能放在 Actions Secrets 或 Cloudflare Worker Secret 中。

## 1. 从 Core 模板创建自己的仓库

1. 打开 [`Publume/core`](https://github.com/Publume/core)。
2. 点击绿色的 **Use this template**。
3. 选择 **Create a new repository**。
4. 选择你的账号作为 Owner，填写仓库名，例如 `my-publume-core`。
5. 建议选择 **Private**，不要勾选 **Include all branches**。
6. 点击 **Create repository from template**。

这里必须使用模板建仓，不要 Fork。此时不需要克隆仓库；本地克隆只在最后部署 Worker 时使用。

## 2. 创建空的 Website 仓库并启用 Pages

1. 在 GitHub 右上角点击 **+**，选择 **New repository**。
2. 使用与 Core 相同的 Owner，填写站点仓库名，例如 `my-publume-site`。
3. 选择 **Public**。
4. 不要添加 README、`.gitignore` 或 License；这个仓库必须是空的。
5. 创建仓库后进入 **Settings → Pages**。
6. 在 **Build and deployment → Source** 中选择 **GitHub Actions**。

Core 的首次 `initial` 运行会把完整站点、至少一篇通过验证的文章和 Pages Workflow 写入这个空仓库。若仓库已有
普通文件且没有 `.publume-site.json`，Core 会拒绝覆盖它。

你的 Pages 地址通常是：

```text
https://你的用户名.github.io/my-publume-site/
```

如果 Website 仓库名正好是 `你的用户名.github.io`，地址则是 `https://你的用户名.github.io/`。

## 3. 创建只写 Website 仓库的 Token

1. 打开 GitHub 个人设置中的 **Developer settings → Personal access tokens → Fine-grained tokens**。
2. 点击 **Generate new token**，设置合理的过期时间。
3. **Repository access** 选择 **Only select repositories**，只选择刚创建的 Website 仓库。
4. 在 **Repository permissions** 中把 **Contents** 设为 **Read and write**。
5. 同一位置把 **Workflows** 也设为 **Read and write**。首次 `initial` 运行需要写入
   `.github/workflows/pages.yml`，缺少这个权限会导致 push 被 GitHub 拒绝。
6. 创建并立即复制 Token。GitHub 之后不会再次显示它。

这些权限与 GitHub 对工作流文件写入的权限要求一致。组织仓库可能要求管理员批准 Fine-grained Token；未批准的
Token 无法克隆或推送目标仓库。

## 4. 配置 Core 仓库

进入你自己的 Core 仓库，打开 **Settings → Secrets and variables → Actions**。

在 **Secrets** 页签添加：

| 名称 | 值 |
| --- | --- |
| `AI_API_KEY` | AI 服务的 API Key。 |
| `TARGET_REPO_TOKEN` | 第 3 步创建的 Fine-grained Token。 |

在 **Variables** 页签添加首次运行所需配置：

| 名称 | 示例或说明 |
| --- | --- |
| `AI_PROVIDER` | `openai-compatible`。这是服务标识。 |
| `AI_BASE_URL` | Chat Completions 接口根地址，例如 `https://api.openai.com/v1`；不要包含 `/chat/completions`。 |
| `AI_MODEL` | 该接口实际支持的模型 ID。 |
| `TARGET_REPOSITORY` | `你的用户名/my-publume-site`，不要填写网页 URL。 |
| `SOURCE_URLS` | 真实信息源地址；多个地址一行一个。 |
| `CONTENT_INSTRUCTIONS` | 写清楚受众、主题、排除项和发布标准。 |
| `SITE_URL` | 第 2 步得到的完整 Pages 地址；项目站点必须保留仓库路径和末尾 `/`。 |

默认主题是 `editorial`，首次部署不需要配置 `THEME`。如果内容需要输出为中文，建议同时添加：

| 名称 | 中文站点示例 |
| --- | --- |
| `OUTPUT_LANGUAGES` | `zh-CN` |
| `DEFAULT_CONTENT_LANGUAGE` | `zh-CN` |
| `SITE_LOCALE` | `zh-CN` |
| `SITE_NAME` | 你的站点名称 |

首次部署先不要配置通知、替换主题或调整阈值。完成三项资源后，再按[完整配置说明](configuration.md)设置
`DELIVERY_CONFIG`、主题、多语言、Prompt 和发布阈值。

## 5. 第一次运行 `initial`

1. 打开 Core 仓库的 **Actions**。
2. 在左侧选择 **Generate and publish**。
3. 点击 **Run workflow**。
4. Branch 选择 `main`，**Run mode** 选择 `initial`。
5. 再次点击绿色的 **Run workflow**，等待运行结束。

首次发布成功必须同时满足：

1. Core 仓库中的 **Generate and publish** 运行显示绿色成功；
2. 运行摘要含有非空的 `targetCommitSha`，且 `published` 至少为 `1`；
3. Website 仓库出现包含生成文章文件的 `content: publish validated articles` 提交；
4. Website 仓库中的 **Deploy site** Workflow 显示绿色成功；
5. **Settings → Pages** 给出的地址可以打开，页面资源路径正常。

GitHub 官方说明 Pages 变更最多可能需要约 10 分钟才可访问。Core Workflow 成功只证明内容已经生成和提交，
不能证明网站已经部署；必须继续检查 Website 的 **Deploy site** 和最终地址。

`initial` 没有任何文章通过验证时会明确失败，不能把空站点标记为就绪。修正信息源、模型或发布要求后才能重试。

## 6. 部署 Cloudflare Trigger Worker

只有第 5 步全部成功以后才执行本节。Worker 每两小时向 Core 仓库发送一次 `publume-schedule` 事件，Core 收到后
以普通 `run` 模式生成内容。

先为 Worker 单独创建一个 Fine-grained Token：

1. **Repository access** 只选择 Core 仓库；
2. **Contents** 设为 **Read and write**；
3. 创建并立即复制 Token。

现在才需要把自己的 Core 仓库克隆到本地：

```bash
git clone https://github.com/你的用户名/my-publume-core.git
cd my-publume-core
```

如果私有仓库克隆时要求密码，用户名填写 GitHub 用户名，密码位置使用刚创建的 Worker Token，不要填写 GitHub
账号密码。

在 Core 仓库根目录创建一个不会提交的 `.env.scheduler`：

```env
GITHUB_TOKEN=你的-Worker-Token
```

登录 Cloudflare 并部署：

```bash
bunx wrangler@4.119.0 login
bunx wrangler@4.119.0 deploy \
  --config scheduler/wrangler.toml \
  --var "GITHUB_REPOSITORY:你的用户名/my-publume-core" \
  --secrets-file .env.scheduler
```

部署完成后立即删除本地 `.env.scheduler`。该文件已被仓库的 `.gitignore` 忽略，但仍不应长期保留。

Worker 没有公开网页。它完成部署必须满足：

1. Cloudflare 中存在 `publume-scheduler` Worker；
2. Worker 显示 Cron Trigger `0 */2 * * *`；
3. 下一次 Cron 触发后，Core 出现由 `repository_dispatch` 启动的 **Generate and publish** 运行；
4. 该运行使用普通 `run` 语义，正常完成，即使摘要中的 `published` 为 `0`。

前两项证明 Worker 和 Cron 已安装；第三、四项才证明 Cloudflare 到 GitHub 的真实触发链路已经接通。
Cloudflare Cron 使用 UTC，`0 */2 * * *` 表示在 UTC 偶数整点运行，不是从部署时刻开始每隔两小时。Cloudflare
说明新的或更新后的 Cron 最多可能需要 15 分钟传播；应在下一个有效触发时间后检查 Core。

## 7. 部署后的运行方式

- 定时运行：Worker 自动发送 `publume-schedule`，不需要人工操作。
- 立即运行：在 Core 的 **Generate and publish** 中选择 `run`。
- 更换主题：修改 `THEME` 后明确选择一次 `bootstrap`；它会保留已生成文章并替换主题。
- 不要重复使用 `initial`：它只用于全新的空 Website 仓库首次发布。

普通 `run` 的 `published: 0` 可以是成功结果，表示本轮没有新内容达到发布标准。

## 完成检查

| 资源 | 完成判据 |
| --- | --- |
| Core | `initial` 成功，摘要有 `targetCommitSha` 且 `published >= 1`。 |
| Website | 有文章提交，**Deploy site** 成功，Pages 地址可访问。 |
| Trigger Worker | Worker 和 Cron 已存在，实际触发过一次 `repository_dispatch` 运行。 |

只有三行都满足，完整的手动部署才算结束。

## 常见失败

| 现象 | 原因和处理 |
| --- | --- |
| `Target fetch failed`、HTTP 403 | 检查 `TARGET_REPO_TOKEN` 是否选中了 Website，并具有 Contents 和 Workflows Read and write；组织 Token 还要确认已经获批。 |
| `Target repository is non-empty and has no compatible .publume-site.json` | Website 不是空仓库。重新创建一个不带 README、`.gitignore` 和 License 的空仓库。 |
| Website 构建成功但没有 Pages 部署 | Website 是私有仓库时，Workflow 只构建归档。公开站点必须使用公开 Website，并把 Pages Source 设为 GitHub Actions。 |
| Website 的 Pages 步骤提示站点不存在或 404 | 在 Website 的 **Settings → Pages** 把 Source 设为 **GitHub Actions**，然后重新运行 **Deploy site**。 |
| Core 最后 `git push` 返回 403 | Core 或组织策略阻止 Actions 写入内容。检查 **Settings → Actions → General** 和 `main` 分支保护规则。 |
| Website 已有文章提交，但 Core 只在 `Persist decision state` 步骤失败 | 不要删除 Website 或重新创建站点。先修复 Core 的 Actions 写权限，再用普通 `run` 继续；同时复核 Website 和 Core 两边的结果。 |
| 网站能打开但资源路径错误 | `SITE_URL` 没有填写完整项目路径。项目站点应类似 `https://owner.github.io/repository/`，修正后运行一次 `run`。 |
| `initial` 报告没有文章通过验证 | 检查信息源可访问性、内容新鲜度、模型输出和 `CONTENT_INSTRUCTIONS`；不要把失败当成空站点成功。 |
| Worker 部署成功但没有触发 Core | 检查 Worker 的 Cron、`GITHUB_REPOSITORY`、Worker Secret `GITHUB_TOKEN`，以及 Token 是否只选择了正确的 Core 仓库并具有 Contents Read and write。 |
| 普通 Workflow 成功但没有新文章 | 这不一定是错误。检查信息源、`MAX_ITEM_AGE_HOURS`、`PUBLISH_THRESHOLD` 和运行摘要中的过滤计数。 |
