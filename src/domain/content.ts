export type SourceReport = {
  readonly sourceId: string
  readonly externalId: string
  readonly canonicalUrl: string
  readonly title: string
  readonly content: string
  readonly publishedAt?: string
  readonly contentOrigin: 'source-summary' | 'article-page'
  readonly acquisition?: 'configured-source' | 'web-search'
}

export type Candidate = SourceReport & {
  readonly reports?: readonly SourceReport[]
}

export type CandidateAdmission = {
  readonly index: number
  readonly score: number
  readonly category: string
  readonly reason: string
}

export type EvidenceClaim = {
  readonly id: string
  readonly text: string
  readonly sourceUrls: readonly string[]
}

export type EvidenceUncertainty = {
  readonly id: string
  readonly text: string
  readonly claimIds: readonly string[]
  readonly sourceUrls: readonly string[]
}

export type GateDecision = {
  readonly publish: boolean
  readonly score: number
  readonly reason: string
  readonly topics: readonly string[]
  readonly risks: readonly string[]
  readonly claims: readonly EvidenceClaim[]
  readonly uncertainties: readonly EvidenceUncertainty[]
  readonly sourceUrls: readonly string[]
}

export type PublicationReference = {
  readonly decisionKey: string
  readonly title: string
  readonly canonicalUrl: string
  readonly publishedAt: string
}

export const storyBlockKinds = [
  'lead',
  'key-points',
  'context',
  'analysis',
  'uncertainty',
  'watch',
  'summary',
  'background',
  'impact',
  'solution',
  'takeaway',
] as const

export type StoryBlockKind = (typeof storyBlockKinds)[number]

export type GeneratedArticle = {
  readonly language: string
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly blocks: readonly StoryBlock[]
  readonly sourceUrls: readonly string[]
}

export type StoryBlock = {
  readonly id: string
  readonly kind: StoryBlockKind
  readonly markdown: string
  readonly claimIds: readonly string[]
  readonly uncertaintyIds: readonly string[]
  readonly sourceUrls: readonly string[]
}

export type ModelCall = {
  readonly operation: 'admission' | 'consolidation' | 'gate' | 'generation' | 'repair' | 'enrichment'
  readonly provider: string
  readonly requestedModel: string
  readonly actualModel?: string
  readonly status: 'succeeded' | 'failed'
  readonly attempts: number
  readonly usage?: {
    readonly promptTokens?: number
    readonly completionTokens?: number
    readonly totalTokens?: number
  }
  readonly error?: string
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
