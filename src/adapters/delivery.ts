import type { DeliveryChannel } from '../app/ports'
import type { DeliveryChannelConfig } from '../config/model'
import type { DeliveryArticle } from '../domain/decisions'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function message(article: DeliveryArticle): string {
  const sources = article.sourceUrls.map((url) => `- ${url}`).join('\n')
  return `${article.title}\n\n${article.summary}\n\nSources\n${sources}`
}

async function responseError(response: Response): Promise<string> {
  const detail = (await response.text()).slice(0, 500)
  return detail || `HTTP ${response.status}`
}

async function postJson(fetchFn: FetchLike, url: string, body: unknown, headers: HeadersInit = {}): Promise<Response> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(await responseError(response))
  return response
}

function webhookBody(type: 'discord' | 'slack' | 'feishu' | 'dingtalk' | 'wecom', text: string): unknown {
  if (type === 'discord') return { content: text }
  if (type === 'slack') return { text }
  if (type === 'feishu') return { msg_type: 'text', content: { text } }
  return { msgtype: 'text', text: { content: text } }
}

async function ensurePlatformSuccess(type: DeliveryChannelConfig['type'], response: Response): Promise<void> {
  if (!['telegram', 'feishu', 'dingtalk', 'wecom'].includes(type)) return
  const body = (await response.json()) as {
    ok?: boolean
    code?: number
    StatusCode?: number
    errcode?: number
    description?: string
    msg?: string
  }
  const succeeded =
    type === 'telegram'
      ? body.ok === true
      : type === 'feishu'
        ? (body.code ?? body.StatusCode) === 0
        : body.errcode === 0
  if (!succeeded) throw new Error(body.description ?? body.msg ?? `${type} rejected the notification`)
}

function createChannel(config: DeliveryChannelConfig, fetchFn: FetchLike): DeliveryChannel {
  return {
    id: config.id,
    async send(article): Promise<void> {
      const text = message(article)
      if (config.type === 'telegram') {
        const response = await postJson(fetchFn, `https://api.telegram.org/bot${config.botToken}/sendMessage`, {
          chat_id: config.chatId,
          text: text.slice(0, 4096),
          disable_web_page_preview: true,
        })
        return ensurePlatformSuccess(config.type, response)
      }
      if ('webhookUrl' in config) {
        const type = config.type as 'discord' | 'slack' | 'feishu' | 'dingtalk' | 'wecom'
        const limit = type === 'discord' ? 2_000 : 20_000
        const response = await postJson(fetchFn, config.webhookUrl, webhookBody(type, text.slice(0, limit)))
        return ensurePlatformSuccess(type, response)
      }
      if (config.type === 'ntfy') {
        const response = await fetchFn(config.topicUrl, {
          method: 'POST',
          headers: { title: article.title.slice(0, 200), 'content-type': 'text/plain; charset=utf-8' },
          body: `${article.summary}\n\n${article.sourceUrls.join('\n')}`,
        })
        if (!response.ok) throw new Error(await responseError(response))
        return
      }
      if (config.type === 'matrix') {
        const room = encodeURIComponent(config.roomId)
        const transaction = crypto.randomUUID()
        const url = `${config.homeserver.replace(/\/$/, '')}/_matrix/client/v3/rooms/${room}/send/m.room.message/${transaction}`
        await postJson(
          fetchFn,
          url,
          { msgtype: 'm.text', body: text },
          { authorization: `Bearer ${config.accessToken}` },
        )
        return
      }
      if (config.type === 'resend') {
        await postJson(
          fetchFn,
          'https://api.resend.com/emails',
          { from: config.from, to: config.to, subject: article.title, text },
          { authorization: `Bearer ${config.apiKey}` },
        )
        return
      }
      if (config.type === 'webhook') {
        await postJson(fetchFn, config.url, { event: 'publume.article.published', article }, config.headers)
        return
      }
      throw new Error(`Unsupported delivery channel: ${config satisfies never}`)
    },
  }
}

export function createDeliveryChannels(
  configs: readonly DeliveryChannelConfig[],
  fetchFn: FetchLike = fetch,
): readonly DeliveryChannel[] {
  return configs.map((config) => createChannel(config, fetchFn))
}
