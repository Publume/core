import { createHmac } from 'node:crypto'
import type { DeliveryChannel } from '../app/ports'
import type { DeliveryChannelConfig } from '../config/model'
import type { DeliveryArticle } from '../domain/decisions'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type WebhookType = 'discord' | 'slack' | 'feishu' | 'dingtalk' | 'wecom'
type WebhookConfig = Extract<DeliveryChannelConfig, { readonly webhookUrl: string }>
type TextLimit = { readonly unit: 'characters' | 'bytes'; readonly maximum: number }

const textEncoder = new TextEncoder()
const textLimits: Readonly<Record<Exclude<DeliveryChannelConfig['type'], 'resend' | 'webhook'>, TextLimit>> = {
  telegram: { unit: 'characters', maximum: 4_096 },
  discord: { unit: 'characters', maximum: 2_000 },
  slack: { unit: 'characters', maximum: 4_000 },
  feishu: { unit: 'bytes', maximum: 8_000 },
  dingtalk: { unit: 'bytes', maximum: 18_000 },
  wecom: { unit: 'bytes', maximum: 2_000 },
  ntfy: { unit: 'bytes', maximum: 4_096 },
  matrix: { unit: 'bytes', maximum: 32_000 },
}

function textLength(text: string, limit: TextLimit): number {
  return limit.unit === 'characters' ? text.length : textEncoder.encode(text).length
}

function truncate(text: string, limit: TextLimit): string {
  if (textLength(text, limit) <= limit.maximum) return text
  const ellipsis = '…'
  const ellipsisLength = textLength(ellipsis, limit)
  if (limit.maximum < ellipsisLength) return ''

  const characters: string[] = []
  let length = 0
  for (const character of text) {
    const characterLength = limit.unit === 'characters' ? character.length : textEncoder.encode(character).length
    if (length + characterLength + ellipsisLength > limit.maximum) break
    characters.push(character)
    length += characterLength
  }
  return `${characters.join('')}${ellipsis}`
}

function articleText(article: DeliveryArticle, limit?: TextLimit, includeTitle = true): string {
  const title = article.title.trim()
  const summary = article.summary.trim()
  const sources = article.sourceUrls.join('\n')
  const complete = [includeTitle ? title : '', summary, sources].filter(Boolean).join('\n\n')
  if (!limit || textLength(complete, limit) <= limit.maximum) return complete

  const prefix = includeTitle && title ? `${title}\n\n` : ''
  const suffix = sources ? `\n\n${sources}` : ''
  if (textLength(`${prefix}${suffix}`, limit) <= limit.maximum) {
    const summaryLimit = { ...limit, maximum: limit.maximum - textLength(`${prefix}${suffix}`, limit) }
    return `${prefix}${truncate(summary, summaryLimit)}${suffix}`
  }

  const firstSource = article.sourceUrls[0] ?? ''
  if (!firstSource) return truncate(title || summary, limit)
  const sourceLimit = { ...limit, maximum: Math.floor(limit.maximum * 0.55) }
  const source = truncate(firstSource, sourceLimit)
  const separator = includeTitle && title ? '\n\n' : ''
  const titleLimit = {
    ...limit,
    maximum: limit.maximum - textLength(`${separator}${source}`, limit),
  }
  return `${includeTitle ? truncate(title, titleLimit) : ''}${separator}${source}`
}

async function responseError(response: Response): Promise<string> {
  const detail = (await response.text()).slice(0, 500)
  return detail || `HTTP ${response.status}`
}

async function requestJson(
  fetchFn: FetchLike,
  url: string,
  body: unknown,
  options: { readonly method?: 'POST' | 'PUT'; readonly headers?: HeadersInit } = {},
): Promise<Response> {
  const response = await fetchFn(url, {
    method: options.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(await responseError(response))
  return response
}

function feishuSignature(timestamp: string, secret: string): string {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')
}

function webhookBody(config: WebhookConfig, text: string): unknown {
  if (config.type === 'discord') return { content: text, allowed_mentions: { parse: [] } }
  if (config.type === 'slack') return { text }
  if (config.type === 'feishu') {
    const body = { msg_type: 'text', content: { text } }
    if (!config.signingSecret) return body
    const timestamp = Math.floor(Date.now() / 1_000).toString()
    return { timestamp, sign: feishuSignature(timestamp, config.signingSecret), ...body }
  }
  return { msgtype: 'text', text: { content: text } }
}

function webhookDestination(config: WebhookConfig): string {
  const url = new URL(config.webhookUrl)
  if (config.type === 'discord') url.searchParams.set('wait', 'true')
  if (config.type === 'dingtalk' && config.signingSecret) {
    const timestamp = Date.now().toString()
    const signature = createHmac('sha256', config.signingSecret)
      .update(`${timestamp}\n${config.signingSecret}`)
      .digest('base64')
    url.searchParams.set('timestamp', timestamp)
    url.searchParams.set('sign', signature)
  }
  return url.href
}

function slackArticle(article: DeliveryArticle): DeliveryArticle {
  const escapeText = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return {
    ...article,
    title: escapeText(article.title),
    summary: escapeText(article.summary),
    sourceUrls: article.sourceUrls.map(escapeText),
  }
}

function encodedNtfyTitle(title: string): string {
  const shortened = truncate(title.trim(), { unit: 'characters', maximum: 200 })
  return /^[\x20-\x7e]*$/.test(shortened)
    ? shortened
    : `=?UTF-8?B?${Buffer.from(shortened, 'utf8').toString('base64')}?=`
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
    errmsg?: string
  }
  const succeeded =
    type === 'telegram'
      ? body.ok === true
      : type === 'feishu'
        ? (body.code ?? body.StatusCode) === 0
        : body.errcode === 0
  if (!succeeded) throw new Error(body.description ?? body.msg ?? body.errmsg ?? `${type} rejected the notification`)
}

function createChannel(config: DeliveryChannelConfig, fetchFn: FetchLike): DeliveryChannel {
  return {
    id: config.id,
    async send(article, deliveryId): Promise<void> {
      if (config.type === 'telegram') {
        const response = await requestJson(fetchFn, `https://api.telegram.org/bot${config.botToken}/sendMessage`, {
          chat_id: config.chatId,
          text: articleText(article, textLimits.telegram),
          link_preview_options: { is_disabled: true },
        })
        return ensurePlatformSuccess(config.type, response)
      }
      if ('webhookUrl' in config) {
        const type: WebhookType = config.type
        const text = articleText(type === 'slack' ? slackArticle(article) : article, textLimits[type])
        const response = await requestJson(fetchFn, webhookDestination(config), webhookBody(config, text))
        return ensurePlatformSuccess(type, response)
      }
      if (config.type === 'ntfy') {
        const response = await fetchFn(config.topicUrl, {
          method: 'POST',
          headers: {
            title: encodedNtfyTitle(article.title),
            'content-type': 'text/plain; charset=utf-8',
          },
          body: articleText(article, textLimits.ntfy, false),
        })
        if (!response.ok) throw new Error(await responseError(response))
        return
      }
      if (config.type === 'matrix') {
        const room = encodeURIComponent(config.roomId)
        const transaction = encodeURIComponent(deliveryId)
        const url = `${config.homeserver.replace(/\/$/, '')}/_matrix/client/v3/rooms/${room}/send/m.room.message/${transaction}`
        await requestJson(
          fetchFn,
          url,
          { msgtype: 'm.notice', body: articleText(article, textLimits.matrix) },
          { method: 'PUT', headers: { authorization: `Bearer ${config.accessToken}` } },
        )
        return
      }
      if (config.type === 'resend') {
        await requestJson(
          fetchFn,
          'https://api.resend.com/emails',
          { from: config.from, to: config.to, subject: article.title, text: articleText(article) },
          { headers: { authorization: `Bearer ${config.apiKey}`, 'idempotency-key': deliveryId } },
        )
        return
      }
      if (config.type === 'webhook') {
        await requestJson(
          fetchFn,
          config.url,
          { event: 'publume.article.published', article },
          { headers: config.headers },
        )
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
