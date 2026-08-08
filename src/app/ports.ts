import type {
  Article,
  Candidate,
  CandidateAdmission,
  CollectionResult,
  EvidenceCollectionResult,
  GateDecision,
  GeneratedArticle,
  ModelCall,
  PublicationReference,
} from '../domain/content'
import type { DecisionState, DeliveryArticle } from '../domain/decisions'

export interface SourceReader {
  collect(): Promise<CollectionResult>
  collectEvidence(candidates: readonly Candidate[]): Promise<EvidenceCollectionResult>
  collectEnrichment?(
    candidates: readonly Candidate[],
    maximumResultsPerStory: number,
  ): Promise<EvidenceCollectionResult>
}

export interface Editorial {
  admit(candidates: readonly Candidate[]): Promise<readonly CandidateAdmission[]>
  consolidate(candidates: readonly Candidate[]): Promise<readonly Candidate[]>
  evaluate(candidate: Candidate, recentPublications: readonly PublicationReference[]): Promise<GateDecision>
  generate(candidate: Candidate, decision: GateDecision): Promise<readonly GeneratedArticle[]>
  provenance?(): readonly ModelCall[]
}

export interface DecisionStore {
  load(): Promise<DecisionState>
  save(state: DecisionState): Promise<void>
}

export interface SitePublisher {
  publishedDecisionKeys(): Promise<ReadonlySet<string>>
  publish(articles: readonly Article[], mode: 'content' | 'bootstrap'): Promise<string | undefined>
  close(): Promise<void>
}

export interface DeliveryChannel {
  readonly id: string
  send(article: DeliveryArticle, deliveryId: string): Promise<void>
}

export type PipelinePorts = {
  readonly sources: SourceReader
  readonly editorial: Editorial
  readonly decisions: DecisionStore
  readonly site: SitePublisher
  readonly delivery: readonly DeliveryChannel[]
}
