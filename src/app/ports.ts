import type {
  Article,
  Candidate,
  CollectionResult,
  GateDecision,
  GeneratedArticle,
  PublicationReference,
} from '../domain/content'
import type { DecisionState, DeliveryArticle } from '../domain/decisions'

export interface SourceReader {
  collect(): Promise<CollectionResult>
}

export interface Editorial {
  evaluate(candidate: Candidate, recentPublications: readonly PublicationReference[]): Promise<GateDecision>
  generate(candidate: Candidate, decision: GateDecision): Promise<readonly GeneratedArticle[]>
}

export interface DecisionStore {
  load(): Promise<DecisionState>
  save(state: DecisionState): Promise<void>
}

export interface SitePublisher {
  publishedDecisionKeys(): Promise<ReadonlySet<string>>
  publish(articles: readonly Article[], mode: 'content' | 'bootstrap'): Promise<string | undefined>
}

export interface DeliveryChannel {
  readonly id: string
  send(article: DeliveryArticle): Promise<void>
}

export type PipelinePorts = {
  readonly sources: SourceReader
  readonly editorial: Editorial
  readonly decisions: DecisionStore
  readonly site: SitePublisher
  readonly delivery: readonly DeliveryChannel[]
}
