export type Candidate = {
  readonly sourceId: string
  readonly externalId: string
  readonly canonicalUrl: string
  readonly title: string
  readonly content: string
  readonly publishedAt?: string
}

export type GateDecision = {
  readonly publish: boolean
  readonly score: number
  readonly reason: string
  readonly topics: readonly string[]
  readonly risks: readonly string[]
}

export type PublicationReference = {
  readonly decisionKey: string
  readonly title: string
  readonly canonicalUrl: string
  readonly publishedAt: string
}

export type GeneratedArticle = {
  readonly language: string
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly sourceUrls: readonly string[]
}

export type Article = GeneratedArticle & {
  readonly decisionKey: string
  readonly publishedAt: string
  readonly score?: number
  readonly topics?: readonly string[]
  readonly topicIds?: readonly string[]
}

export type CollectionResult = {
  readonly candidates: readonly Candidate[]
  readonly errors: readonly { sourceId: string; error: string }[]
}
