import { describe, expect, it } from 'bun:test'
import { createDeliveryChannels } from '../src/adapters/delivery'

const article = {
  language: 'en',
  title: 'A verified update',
  summary: 'A concise source-backed summary.',
  sourceUrls: ['https://example.test/source'],
}

describe('delivery adapters', () => {
  it('uses the Telegram Bot API without exposing credentials in the message', async () => {
    const requests: { url: string; body: unknown }[] = []
    const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return Response.json({ ok: true })
    }
    const [channel] = createDeliveryChannels(
      [{ id: 'tg', type: 'telegram', botToken: '1234:secret-token', chatId: '42' }],
      fetchFn,
    )

    await channel?.send(article)

    expect(requests[0]?.url).toContain('/bot1234:secret-token/sendMessage')
    expect(requests[0]?.body).toMatchObject({ chat_id: '42' })
    expect(JSON.stringify(requests[0]?.body)).not.toContain('secret-token')
  })

  it('formats free webhook channels with their native payload shape', async () => {
    const bodies: unknown[] = []
    const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(null, { status: 204 })
    }
    const channels = createDeliveryChannels(
      [
        { id: 'discord', type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/token' },
        { id: 'slack', type: 'slack', webhookUrl: 'https://hooks.slack.com/services/example' },
      ],
      fetchFn,
    )

    for (const channel of channels) await channel.send(article)

    expect(bodies[0]).toHaveProperty('content')
    expect(bodies[1]).toHaveProperty('text')
  })

  it('fails a channel when its platform returns a business error', async () => {
    const [channel] = createDeliveryChannels(
      [{ id: 'tg', type: 'telegram', botToken: '1234:token', chatId: '42' }],
      async () => Response.json({ ok: false, description: 'chat not found' }),
    )

    expect(channel?.send(article)).rejects.toThrow('chat not found')
  })
})
