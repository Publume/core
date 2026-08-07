export type SourceReport = {
  readonly sourceId: string
  readonly externalId: string
  readonly canonicalUrl: string
  readonly title: string
  readonly content: string
  readonly publishedAt?: string
  readonly contentOrigin: 'source-summary' | 'article-page'
}

export type Candidate = SourceReport & {
  readonly reports?: readonly SourceReport[]
}

export type GateDecision = {
  readonly publish: boolean
  readonly score: number
  readonly reason: string
  readonly topics: readonly string[]
  readonly risks: readonly string[]
  readonly verifiedFacts: readonly string[]
  readonly uncertainties: readonly string[]
  readonly sourceUrls: readonly string[]
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

export type EvidenceCollectionResult = {
  readonly candidates: readonly Candidate[]
  readonly errors: readonly { sourceId: string; url: string; error: string }[]
  readonly fetched: number
}

export function candidateReports(candidate: Candidate): readonly SourceReport[] {
  return candidate.reports?.length ? candidate.reports : [candidate]
}
