# GitHub 手动部署

[English](deployment.en.md) | **简体中文**

这份教程用于不经过 Publume Cloud、直接在 GitHub 上部署 Publume Core。第一次部署只需要两个仓库：

```text
你的 Core 仓库（私有，保存配置和运行状态）
        |
        v
你的 Website 仓库（公开，保存站点并部署 GitHub Pages）
```

请按下面的顺序操作。第一次成功以前不要配置定时任务，也不要先运行普通 `run`。

## 准备

你需要：

- 一个 GitHub 账号；
- 一个可用的 OpenAI Chat Completions 兼容接口、API Key 和模型名；
- 至少一个确认可以访问的 RSS、Atom、JSON 或 HTML 信息源。

GitHub Free 可以从公开仓库发布 Pages。Website 仓库使用私有可见性时，需要支持私有 Pages 的 GitHub 套餐。
Core 仓库建议设为私有，因为它会保存运行状态和站点配置。API Key 和 Token 只能放在 Actions Secrets 中。

## 1. 从 Core 模板创建自己的仓库

1. 打开 [`Publume/core`](https://github.com/Publume/core)。
2. 点击绿色的 **Use this template**。
3. 选择 **Create a new repository**。
4. 选择你的账号作为 Owner，填写仓库名，例如 `my-publume-core`。
5. 建议选择 **Private**，不要勾选 **Include all branches**。
6. 点击 **Create repository from template**。

这里必须使用模板建仓。不要 Fork，也不需要先在本地执行 `git clone`。

## 2. 创建空的 Website 仓库并启用 Pages

1. 在 GitHub 右上角点击 **+**，选择 **New repository**。
2. 使用与 Core 相同的 Owner，填写站点仓库名，例如 `my-publume-site`。
3. 选择 **Public**。
4. 不要添加 README、`.gitignore` 或 License；这个仓库必须是空的。
5. 创建仓库后进入 **Settings → Pages**。
6. 在 **Build and deployment → Source** 中选择 **GitHub Actions**。

Core 的首次 `initial` 运行会把完整站点、基线文章和 Pages Workflow 写入这个空仓库。若仓库已有普通文件且没有
`.publume-site.json`，Core 会拒绝覆盖它。

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

组织仓库可能要求管理员批准 Fine-grained Token；未批准的 Token 无法克隆或推送目标仓库。

## 4. 配置 Core 仓库

进入你自己的 Core 仓库，打开 **Settings → Secrets and variables → Actions**。

在 **Secrets** 页签添加：

| 名称 | 值 |
| --- | --- |
| `AI_API_KEY` | AI 服务的 API Key。 |
| `TARGET_REPO_TOKEN` | 第 3 步创建的 Fine-grained Token。 |

通知渠道不是首次部署的必需项，可以先跳过。需要通知时按本节后面的“配置通知”添加 `DELIVERY_CONFIG`。

在 **Variables** 页签至少添加：

| 名称 | 示例或说明 |
| --- | --- |
| `AI_PROVIDER` | `openai-compatible`。这是服务标识。 |
| `AI_BASE_URL` | Chat Completions 接口的根地址，例如 `https://api.openai.com/v1`。不要包含 `/chat/completions`。 |
| `AI_MODEL` | 该接口实际支持的模型 ID。 |
| `TARGET_REPOSITORY` | `你的用户名/my-publume-site`，不要填写网页 URL。 |
| `SOURCE_URLS` | 真实信息源地址；多个地址一行一个。 |
| `CONTENT_INSTRUCTIONS` | 写清楚受众、主题、排除项和发布标准。 |
| `SITE_URL` | 第 2 步得到的完整 Pages 地址，项目站点必须保留仓库路径和末尾 `/`。 |
| `THEME` | 站点模板 ID，例如 `editorial`；完整列表见下方。 |

建议同时添加下面这些变量，让首个页面直接符合你的语言和站点名称：

| 名称 | 中文站点示例 |
| --- | --- |
| `OUTPUT_LANGUAGES` | `zh-CN` |
| `DEFAULT_CONTENT_LANGUAGE` | `zh-CN` |
| `SITE_LOCALE` | `zh-CN` |
| `SITE_NAME` | 你的站点名称 |

### 选择站点模板

`THEME` 决定首次 `initial` 运行安装哪个站点模板。不配置时默认使用 `editorial`。当前
[`Publume/themes`](https://github.com/Publume/themes) 提供：

| `THEME` 值 | 适合的内容 |
| --- | --- |
| `editorial` | 新闻、评论和通用内容，强调快速清晰阅读。 |
| `journal` | 长文和杂志内容，强调温暖的排版。 |
| `briefing` | 高密度情报和快速浏览。 |
| `terminal` | AI、开发、云计算和安全资讯。 |
| `ledger` | 市场、商业、加密和能源内容。 |
| `atlas` | 世界、气候、地理和旅行内容。 |
| `laboratory` | 科学、健康、机器人和研究记录。 |
| `orbit` | 航天、防务、出行和机器人内容。 |
| `studio` | 设计、文化和消费科技内容。 |
| `arcade` | 游戏、数码产品和数字文化。 |
| `scoreboard` | 体育、赛事排名和出行内容。 |
| `table` | 美食、旅行和文化内容。 |

官方模板仓库通常不需要另外配置下面两个变量；需要固定来源时再添加：

| 名称 | 默认值 | 用途 |
| --- | --- | --- |
| `THEME_REPOSITORY` | `Publume/themes` | 模板来源仓库。 |
| `THEME_REF` | `main` | 模板仓库的分支、Tag 或 Commit-like fetch ref。 |

以后更换模板时，修改 `THEME`，然后明确运行一次 `bootstrap`。Core 会保留已经生成的文章并替换模板；普通
`run` 不会更换模板。

### 配置通知（可选）

通知配置和凭据必须放在 Core 仓库的 **Settings → Secrets and variables → Actions → Secrets** 中：

1. 点击 **New repository secret**；
2. Name 填写 `DELIVERY_CONFIG`；
3. Secret 填写一个 JSON 数组，数组中的每个对象代表一个通知渠道；
4. 保存后运行普通 `run`。不要把该 JSON 放进 Variables，也不要提交到仓库。

例如，同时发送到 Telegram 和 Discord：

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

每个 `id` 必须唯一且长期保持不变，只能使用字母、数字、点、下划线和连字符。当前支持的配置为：

| `type` | 必填字段 | 说明 |
| --- | --- | --- |
| `telegram` | `botToken`, `chatId` | `chatId` 可以是数字 ID 或 `@channel_name`。Bot 必须有发送权限。 |
| `discord` | `webhookUrl` | Discord Incoming Webhook 的完整 HTTPS 地址。 |
| `slack` | `webhookUrl` | Slack Incoming Webhook 的完整 HTTPS 地址。 |
| `feishu` | `webhookUrl` | 飞书自定义机器人 Webhook。 |
| `dingtalk` | `webhookUrl` | 钉钉自定义机器人 Webhook。 |
| `wecom` | `webhookUrl` | 企业微信群机器人 Webhook。 |
| `ntfy` | `topicUrl` | 完整 HTTPS Topic 地址，例如 `https://ntfy.sh/your-private-topic`。 |
| `matrix` | `homeserver`, `roomId`, `accessToken` | Homeserver 必须是 HTTPS，账号必须能向目标 Room 发消息。 |
| `resend` | `apiKey`, `from`, `to` | `from` 是已验证发件地址；`to` 是包含 1–20 个邮箱地址的数组。 |
| `webhook` | `url`；可选 `headers` | 通用 HTTPS Webhook；`headers` 是字符串键值对象，可放认证 Header。 |

飞书、钉钉和企业微信必须使用能够接受普通文本请求的机器人配置；当前适配器不会另外计算平台签名。禁用全部通知
时，可以删除 `DELIVERY_CONFIG`，或把它设为 `[]`。

`initial` 或普通 `run` 发布新文章后会发送通知；`bootstrap` 和没有新文章的运行不会发送。运行结束后检查摘要：

- `deliveriesSent`：本轮发送成功的数量；
- `deliveriesFailed`：本轮发送失败的数量；
- `deliveriesPending`：仍在等待下次运行重试的数量。

一次完全成功的通知运行应当是 `deliveriesSent > 0`、`deliveriesFailed = 0`、`deliveriesPending = 0`。发送失败
不会回滚已经发布的文章；Core 会保存待发送项，并在下一次 `run` 重试。

其余变量都有默认值。阈值、Prompt、通知和多语言配置见[完整配置说明](configuration.md)。

## 5. 第一次运行 `initial`

1. 打开 Core 仓库的 **Actions**。
2. 在左侧选择 **Generate and publish**。
3. 点击 **Run workflow**。
4. Branch 选择 `main`，**Run mode** 选择 `initial`。
5. 再次点击绿色的 **Run workflow**，等待运行结束。

首次部署成功必须同时满足四个条件：

1. Core 仓库中的 **Generate and publish** 运行显示绿色成功；
2. 运行摘要含有非空的 `targetCommitSha`，且 `published` 至少为 `1`；
3. Website 仓库出现包含生成文章文件的 `content: publish validated articles` 提交；
4. Website 仓库中的 **Deploy site** Workflow 显示绿色成功，并且 **Settings → Pages** 给出的地址可以打开。

Pages 首次发布可能需要等待一两分钟。只有 Core Workflow 成功不代表网站已经部署完成，必须继续检查 Website
仓库的 **Deploy site**。

## 6. 手动生成内容

站点首次部署成功后，再回到 Core 仓库运行 **Generate and publish**，这次把 **Run mode** 设为 `run`。
普通运行会读取真实信息源、调用 AI，并只发布通过过滤和阈值的内容。

`published: 0` 仍然可以是一次成功的普通运行：这表示本轮没有新内容达到发布标准。首次 `initial` 如果没有
任何文章通过验证会明确失败，不能把空站点标记为就绪。明确更换主题时应选择 `bootstrap`，不要重复选择 `initial`。

## 常见失败

| 现象 | 原因和处理 |
| --- | --- |
| `Target clone failed`、HTTP 403 | 检查 `TARGET_REPO_TOKEN` 是否选中了 Website 仓库，并具有 Contents 和 Workflows Read and write。组织 Token 还要确认已经获批。 |
| `Target repository is non-empty and has no compatible .publume-site.json` | Website 仓库不是空仓库。重新创建一个不带 README、`.gitignore` 和 License 的空仓库。 |
| Website 的 Pages 步骤提示站点不存在或 404 | 在 Website 仓库 **Settings → Pages** 把 Source 设为 **GitHub Actions**，然后重新运行 **Deploy site**。 |
| Core 最后 `git push` 返回 403 | Core 仓库或组织策略阻止 Actions 写入内容。检查 **Settings → Actions → General** 和 `main` 分支保护规则。 |
| 网站能打开但资源路径错误 | `SITE_URL` 没有填写完整项目路径。项目站点应类似 `https://owner.github.io/repository/`，修正后运行一次 `run`。 |
| Workflow 成功但没有新文章 | 这不一定是错误。检查信息源是否有新内容、`MAX_ITEM_AGE_HOURS`、`PUBLISH_THRESHOLD` 和运行摘要中的过滤计数。 |

## 可选：每两小时自动运行

先完成上面的手动闭环，再部署 `scheduler/` 中的 Cloudflare Worker。它每两小时向 Core 仓库发送一次
`publume-schedule` 事件。

为 Scheduler 单独创建一个 Fine-grained Token：只选择 Core 仓库，并授予 **Contents: Read and write**。在本地
Core 仓库根目录创建一个不会提交的 `.env.scheduler`：

```env
GITHUB_TOKEN=你的-Scheduler-Token
```

然后执行：

```bash
bunx wrangler@4.119.0 login
bunx wrangler@4.119.0 deploy \
  --config scheduler/wrangler.toml \
  --var "GITHUB_REPOSITORY:你的用户名/my-publume-core" \
  --secrets-file .env.scheduler
```

部署成功后删除本地 `.env.scheduler`。该文件已被仓库的 `.gitignore` 忽略，但仍不应长期保留。Scheduler
没有公开网页；它的成功判据是 Cloudflare 中存在 `publume-scheduler` Worker 和 Cron Trigger，下一次触发后
Core 仓库出现由 `repository_dispatch` 启动的 **Generate and publish** 运行。
