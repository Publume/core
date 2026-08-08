import { z } from 'zod'
import type { Source } from '../../config/model'
import type { Candidate } from '../../domain/content'
import { candidateFrom } from './candidate'
import { type FetchLike, fetchResponse } from './http'

const apiUrl = 'https://api.producthunt.com/v2/api/graphql'
const maximumPosts = 50
const retryableHttpStatuses = new Set([408, 425, 500, 502, 503, 504])

const responseSchema = z.object({
  data: z
    .object({
      posts: z.object({
        nodes: z.array(
          z.object({
            id: z.union([z.string().min(1), z.number()]),
            name: z.string().min(1),
            tagline: z.string().nullish(),
            description: z.string().nullish(),
            url: z.string().min(1),
            createdAt: z.string().min(1),
          }),
        ),
      }),
    })
    .nullish(),
  errors: z.array(z.object({ message: z.string() })).optional(),
})

export function isProductHuntFeed(source: Source): boolean {
  const url = new URL(source.url)
  return ['producthunt.com', 'www.producthunt.com'].includes(url.hostname.toLowerCase()) && url.pathname === '/feed'
}

export async function collectProductHuntSource(
  source: Source,
  apiToken: string,
  fetchFn: FetchLike,
  timeoutMs: number,
): Promise<Candidate[]> {
  const response = await fetchResponse(
    fetchFn,
    apiUrl,
    timeoutMs,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: `query PublumeProductHuntPosts($first: Int!) {
  posts(first: $first, order: NEWEST) {
    nodes { id name tagline description url createdAt }
  }
}`,
        variables: { first: maximumPosts },
      }),
    },
    retryableHttpStatuses,
  )
  if (!response.ok) {
    const reset = response.headers.get('x-rate-limit-reset')
    await response.body?.cancel()
    if (response.status === 429)
      throw new Error(`Product Hunt API HTTP 429${reset ? `; quota resets in ${reset} seconds` : ''}`)
    if ([401, 403].includes(response.status))
      throw new Error(`Product Hunt API token was rejected (HTTP ${response.status})`)
    throw new Error(`Product Hunt API HTTP ${response.status}`)
  }

  const parsed = responseSchema.safeParse((await response.json()) as unknown)
  if (!parsed.success) throw new Error('Product Hunt API returned an invalid response')
  if (parsed.data.errors?.length)
    throw new Error(`Product Hunt API GraphQL error: ${parsed.data.errors.map((error) => error.message).join('; ')}`)
  if (!parsed.data.data) throw new Error('Product Hunt API returned no data')

  return parsed.data.data.posts.nodes.flatMap((post) => {
    const content = [post.tagline, post.description]
      .flatMap((value) => (value?.trim() ? [value.trim()] : []))
      .join('\n\n')
    const candidate = candidateFrom(
      source.id,
      {
        externalId: post.id,
        url: post.url,
        title: post.name,
        content,
        publishedAt: post.createdAt,
        contentOrigin: 'article-page',
      },
      source.url,
    )
    return candidate ? [candidate] : []
  })
}
