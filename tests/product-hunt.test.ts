import { describe, expect, it } from 'bun:test'
import { createSourceReader } from '../src/adapters/sources/reader'

const source = [{ id: 'product-hunt', url: 'https://www.producthunt.com/feed' }]
const response = (body: string, contentType: string) => new Response(body, { headers: { 'content-type': contentType } })

describe('Product Hunt source adapter', () => {
  it('skips Product Hunt without a configured API token', async () => {
    const requests: string[] = []
    const reader = createSourceReader(source, 20_000, async (input) => {
      requests.push(String(input))
      throw new Error('Product Hunt should not be requested without a token')
    })

    expect(await reader.collect()).toEqual({ candidates: [], errors: [] })
    expect(requests).toEqual([])
  })

  it('uses the Product Hunt API as complete evidence when a token is configured', async () => {
    const requests: { url: string; init?: RequestInit }[] = []
    const reader = createSourceReader(
      source,
      20_000,
      async (input, init) => {
        requests.push({ url: String(input), init })
        return response(
          JSON.stringify({
            data: {
              posts: {
                nodes: [
                  {
                    id: 'post-1',
                    name: 'Verified Product',
                    tagline: 'A concise Product Hunt tagline.',
                    description: 'The official Product Hunt description supplies complete primary-source evidence.',
                    url: 'https://www.producthunt.com/posts/verified-product',
                    createdAt: '2026-08-09T00:00:00Z',
                  },
                ],
              },
            },
          }),
          'application/json',
        )
      },
      { productHuntApiToken: 'product-hunt-token' },
    )

    const collection = await reader.collect()
    const evidence = await reader.collectEvidence(collection.candidates)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.producthunt.com/v2/api/graphql')
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe('Bearer product-hunt-token')
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ variables: { first: 50 } })
    expect(collection.errors).toEqual([])
    expect(collection.candidates[0]).toMatchObject({
      sourceId: 'product-hunt',
      externalId: 'post-1',
      canonicalUrl: 'https://www.producthunt.com/posts/verified-product',
      title: 'Verified Product',
      contentOrigin: 'article-page',
      publishedAt: '2026-08-09T00:00:00Z',
    })
    expect(collection.candidates[0]?.content).toContain('complete primary-source evidence')
    expect(evidence).toEqual({ candidates: collection.candidates, errors: [], fetched: 0 })
  })

  it('reports API rate limits without requesting product pages', async () => {
    const requests: string[] = []
    const reader = createSourceReader(
      source,
      20_000,
      async (input) => {
        requests.push(String(input))
        return new Response(null, { status: 429, headers: { 'x-rate-limit-reset': '600' } })
      },
      { productHuntApiToken: 'product-hunt-token' },
    )

    const collection = await reader.collect()

    expect(requests).toEqual(['https://api.producthunt.com/v2/api/graphql'])
    expect(collection.candidates).toEqual([])
    expect(collection.errors).toEqual([
      { sourceId: 'product-hunt', error: 'Product Hunt API HTTP 429; quota resets in 600 seconds' },
    ])
  })
})
