import type { Candidate } from '../../domain/content'

export function canonicalUrl(value: string, base?: string): string {
  try {
    const url = new URL(value, base)
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || ['fbclid', 'gclid', 'ref'].includes(key.toLowerCase()))
        url.searchParams.delete(key)
    }
    url.hash = ''
    return url.toString()
  } catch {
    return value.trim()
  }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number') return String(value)
  return undefined
}

export type CandidateFields = {
  readonly externalId?: unknown
  readonly url?: unknown
  readonly title?: unknown
  readonly content?: unknown
  readonly publishedAt?: unknown
}

export function candidateFrom(sourceId: string, fields: CandidateFields, baseUrl: string): Candidate | undefined {
  const url = canonicalUrl(stringValue(fields.url) || baseUrl, baseUrl)
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return undefined
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) return undefined

  const title = stringValue(fields.title) || url
  return {
    sourceId,
    externalId: stringValue(fields.externalId) || url,
    canonicalUrl: url,
    title,
    content: stringValue(fields.content) || title,
    publishedAt: stringValue(fields.publishedAt),
  }
}
