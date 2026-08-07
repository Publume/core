function topicHash(value: string): string {
  let hash = 2_166_136_261
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(36)
}

export function topicIdForLabel(label: string): string {
  const normalized = label.trim().toLowerCase().normalize('NFKD')
  const slug = normalized
    .replace(/\p{Mark}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `${slug || 'topic'}-${topicHash(normalized)}`
}

export function normalizeTopics(topics: readonly string[]): {
  readonly labels: readonly string[]
  readonly ids: readonly string[]
} {
  const labels = [...new Set(topics.map((topic) => topic.trim()).filter(Boolean))]
  return { labels, ids: labels.map(topicIdForLabel) }
}
