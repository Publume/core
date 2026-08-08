import { describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import { createDeliveryChannels } from '../src/adapters/delivery'
import type { DeliveryChannelConfig } from '../src/config/model'
import type { DeliveryArticle } from '../src/domain/decisions'

const sourceUrl = 'https://example.test/source'
const article: DeliveryArticle = {
  language: 'zh-CN',
  title: '\u{5DF2}\u{6838}\u{5B9E}\u{7684}\u{91CD}\u{8981}\u{66F4}\u{65B0}',
  summary:
    '\u{4E00}\u{6BB5}\u{7B80}\u{6D01}\u{3001}\u{6709}\u{6765}\u{6E90}\u{652F}\u{6301}\u{7684}\u{6458}\u{8981}\u{3002}',
  sourceUrls: [sourceUrl],
}

type RecordedRequest = {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body: unknown
}

function successResponse(url: string): Response {
  if (url.includes('api.telegram.org')) return Response.json({ ok: true })
  if (url.includes('/feishu')) return Response.json({ code: 0, msg: 'success' })
  if (url.includes('/dingtalk') || url.includes('/wecom')) return Response.json({ errcode: 0, errmsg: 'ok' })
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
}

type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function recorder(): { readonly requests: RecordedRequest[]; readonly fetch: FetchStub } {
  const requests: RecordedRequest[] = []
  return {
    requests,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers)
      const serialized = String(init?.body ?? '')
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers,
        body: headers.get('content-type') === 'application/json' ? JSON.parse(serialized) : serialized,
      })
      return successResponse(String(input))
    },
  }
}

const configs: readonly DeliveryChannelConfig[] = [
  { id: 'telegram', type: 'telegram', botToken: '1234:secret-token', chatId: '42' },
  { id: 'discord', type: 'discord', webhookUrl: 'https://hooks.example.test/discord' },
  { id: 'slack', type: 'slack', webhookUrl: 'https://hooks.example.test/slack' },
  {
    id: 'feishu',
    type: 'feishu',
    webhookUrl: 'https://hooks.example.test/feishu',
    signingSecret: 'feishu-secret',
  },
  {
    id: 'dingtalk',
    type: 'dingtalk',
    webhookUrl: 'https://hooks.example.test/dingtalk',
    signingSecret: 'dingtalk-secret',
  },
  { id: 'wecom', type: 'wecom', webhookUrl: 'https://hooks.example.test/wecom' },
  { id: 'ntfy', type: 'ntfy', topicUrl: 'https://ntfy.example.test/publume' },
  {
    id: 'matrix',
    type: 'matrix',
    homeserver: 'https://matrix.example.test',
    roomId: '!room:example.test',
    accessToken: 'matrix-token',
  },
  {
    id: 'resend',
    type: 'resend',
    apiKey: 'resend-token',
    from: 'brief@example.test',
    to: ['reader@example.test'],
  },
  {
    id: 'webhook',
    type: 'webhook',
    url: 'https://hooks.example.test/generic',
    headers: { 'x-publume-test': 'yes' },
  },
]

function requestFor(requests: readonly RecordedRequest[], marker: string): RecordedRequest {
  const request = requests.find(({ url }) => url.includes(marker))
  if (!request) throw new Error(`Missing request containing ${marker}`)
  return request
}

describe('delivery adapters', () => {
  it('uses each provider transport and native payload contract', async () => {
    const recorded = recorder()
    const channels = createDeliveryChannels(configs, recorded.fetch)

    for (const channel of channels) await channel.send(article, `delivery-${channel.id}`)

    expect(recorded.requests).toHaveLength(10)

    const telegram = requestFor(recorded.requests, 'api.telegram.org')
    expect(telegram.method).toBe('POST')
    expect(telegram.body).toMatchObject({ chat_id: '42', link_preview_options: { is_disabled: true } })
    expect(JSON.stringify(telegram.body)).not.toContain('secret-token')

    const discord = requestFor(recorded.requests, '/discord')
    expect(new URL(discord.url).searchParams.get('wait')).toBe('true')
    expect(discord.body).toMatchObject({ content: expect.any(String), allowed_mentions: { parse: [] } })

    expect(requestFor(recorded.requests, '/slack').body).toMatchObject({ text: expect.any(String) })
    const feishu = requestFor(recorded.requests, '/feishu')
    expect(feishu.body).toMatchObject({
      msg_type: 'text',
      content: { text: expect.any(String) },
    })
    const feishuSignature = feishu.body as { timestamp: string; sign: string }
    expect(feishuSignature.sign).toBe(
      createHmac('sha256', `${feishuSignature.timestamp}\nfeishu-secret`).update('').digest('base64'),
    )

    const dingtalk = requestFor(recorded.requests, '/dingtalk')
    const dingtalkUrl = new URL(dingtalk.url)
    const dingtalkTimestamp = dingtalkUrl.searchParams.get('timestamp') ?? ''
    expect(dingtalkUrl.searchParams.get('sign')).toBe(
      createHmac('sha256', 'dingtalk-secret').update(`${dingtalkTimestamp}\ndingtalk-secret`).digest('base64'),
    )
    for (const request of [dingtalk, requestFor(recorded.requests, '/wecom')])
      expect(request.body).toEqual({ msgtype: 'text', text: { content: expect.any(String) } })

    const ntfy = requestFor(recorded.requests, 'ntfy.example.test')
    expect(ntfy.headers.get('title')).toStartWith('=?UTF-8?B?')
    expect(ntfy.body).toContain(sourceUrl)

    const matrix = requestFor(recorded.requests, '_matrix')
    expect(matrix.method).toBe('PUT')
    expect(matrix.url).toContain('/delivery-matrix')
    expect(matrix.headers.get('authorization')).toBe('Bearer matrix-token')
    expect(matrix.body).toEqual({ msgtype: 'm.notice', body: expect.any(String) })

    const resend = requestFor(recorded.requests, 'api.resend.com')
    expect(resend.headers.get('authorization')).toBe('Bearer resend-token')
    expect(resend.headers.get('idempotency-key')).toBe('delivery-resend')
    expect(resend.body).toMatchObject({
      from: 'brief@example.test',
      to: ['reader@example.test'],
      subject: article.title,
      text: expect.stringContaining(sourceUrl),
    })

    const webhook = requestFor(recorded.requests, '/generic')
    expect(webhook.headers.get('x-publume-test')).toBe('yes')
    expect(webhook.body).toEqual({ event: 'publume.article.published', article })
  })

  it('preserves the source link while respecting channel text limits', async () => {
    const recorded = recorder()
    const longArticle: DeliveryArticle = {
      ...article,
      title: article.title.repeat(40),
      summary: '\u{5F88}\u{957F}\u{7684}\u{6458}\u{8981}\u{3002}'.repeat(5_000),
    }
    const channels = createDeliveryChannels(configs, recorded.fetch)

    for (const channel of channels) await channel.send(longArticle, `long-${channel.id}`)

    const textByProvider = new Map<string, string>([
      ['telegram', String((requestFor(recorded.requests, 'api.telegram.org').body as { text: string }).text)],
      ['discord', String((requestFor(recorded.requests, '/discord').body as { content: string }).content)],
      ['slack', String((requestFor(recorded.requests, '/slack').body as { text: string }).text)],
      ['feishu', String((requestFor(recorded.requests, '/feishu').body as { content: { text: string } }).content.text)],
      [
        'dingtalk',
        String((requestFor(recorded.requests, '/dingtalk').body as { text: { content: string } }).text.content),
      ],
      ['wecom', String((requestFor(recorded.requests, '/wecom').body as { text: { content: string } }).text.content)],
      ['ntfy', String(requestFor(recorded.requests, 'ntfy.example.test').body)],
      ['matrix', String((requestFor(recorded.requests, '_matrix').body as { body: string }).body)],
      ['resend', String((requestFor(recorded.requests, 'api.resend.com').body as { text: string }).text)],
    ])

    for (const text of textByProvider.values()) expect(text).toContain(sourceUrl)
    expect(Array.from(textByProvider.get('telegram') ?? '')).toHaveLength(4096)
    expect(Array.from(textByProvider.get('discord') ?? '')).toHaveLength(2000)
    expect(Array.from(textByProvider.get('slack') ?? '').length).toBeLessThanOrEqual(4000)
    expect(new TextEncoder().encode(textByProvider.get('feishu')).length).toBeLessThanOrEqual(18_000)
    expect(new TextEncoder().encode(textByProvider.get('dingtalk')).length).toBeLessThanOrEqual(18_000)
    expect(new TextEncoder().encode(textByProvider.get('wecom')).length).toBeLessThanOrEqual(2_000)
    expect(new TextEncoder().encode(textByProvider.get('ntfy')).length).toBeLessThanOrEqual(4_096)
    expect(new TextEncoder().encode(textByProvider.get('matrix')).length).toBeLessThanOrEqual(32_000)
  })

  it('counts supplementary Unicode safely and neutralizes Slack control mentions', async () => {
    const recorded = recorder()
    const [discord, slack] = createDeliveryChannels(
      configs.filter(({ type }) => type === 'discord' || type === 'slack'),
      recorded.fetch,
    )
    const unicodeArticle: DeliveryArticle = {
      ...article,
      summary: `<!here> ${'😀'.repeat(3_000)}`,
    }

    await discord?.send(unicodeArticle, 'unicode-discord')
    await slack?.send(unicodeArticle, 'unicode-slack')

    const discordText = String((requestFor(recorded.requests, '/discord').body as { content: string }).content)
    const slackText = String((requestFor(recorded.requests, '/slack').body as { text: string }).text)
    expect(discordText.length).toBeLessThanOrEqual(2_000)
    expect(slackText).not.toContain('<!here>')
    expect(slackText).toContain('&lt;!here&gt;')
    expect(slackText).toContain(sourceUrl)
  })

  it('keeps the complete Feishu JSON request below the documented 20 KB limit', async () => {
    const recorded = recorder()
    const [feishu] = createDeliveryChannels(
      configs.filter(({ type }) => type === 'feishu'),
      recorded.fetch,
    )

    await feishu?.send({ ...article, summary: '"\\\n'.repeat(10_000) }, 'large-feishu')

    const request = requestFor(recorded.requests, '/feishu')
    expect(new TextEncoder().encode(JSON.stringify(request.body)).length).toBeLessThanOrEqual(20 * 1_024)
    expect(JSON.stringify(request.body)).toContain(sourceUrl)
  })

  it.each([
    ['telegram', { ok: false, description: 'chat not found' }, 'chat not found'],
    ['feishu', { code: 19001, msg: 'invalid webhook' }, 'invalid webhook'],
    ['dingtalk', { errcode: 310000, errmsg: 'keywords not in content' }, 'keywords not in content'],
    ['wecom', { errcode: 93000, errmsg: 'invalid webhook' }, 'invalid webhook'],
  ] as const)('fails %s when the platform returns a business error', async (type, body, message) => {
    const config = configs.find((candidate) => candidate.type === type)
    if (!config) throw new Error(`Missing ${type} config`)
    const [channel] = createDeliveryChannels([config], async () => Response.json(body))

    expect(channel?.send(article, `failure-${type}`)).rejects.toThrow(message)
  })
})
