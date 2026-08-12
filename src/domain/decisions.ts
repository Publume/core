import { createHash } from 'node:crypto'
import type { GeneratedArticle } from './content'

export type DeliveryArticle = Pick<GeneratedArticle, 'language' | 'title' | 'summary' | 'sourceUrls'>

export type DecisionStatus = 'rejected' | 'generated' | 'published' | 'failed'

export type DecisionRecord = {
  readonly decisionKey: string
  readonly status: DecisionStatus
  readonly reason?: string
  readonly score?: number
  readonly configHash: string
  readonly updatedAt: string
  readonly targetCommitSha?: string
  readonly candidateTitle?: string
  readonly canonicalUrl?: string
  readonly modelFailureCount?: number
}

export type DecisionState = {
  readonly version: 1
  decisions: Record<string, DecisionRecord>
  processedCandidates?: Record<string, string>
  readonly sourceCheckpoints: Record<string, string>
  pendingDeliveries: PendingDelivery[]
  configHash?: string
  lastRunAt?: string
}

export type PendingDelivery = {
  readonly id: string
  readonly channelId: string
  readonly article: DeliveryArticle
  readonly createdAt: string
  attempts: number
  lastError?: string
}

export function emptyDecisionState(): DecisionState {
  return { version: 1, decisions: {}, processedCandidates: {}, sourceCheckpoints: {}, pendingDeliveries: [] }
}

export function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function makeDecisionKey(sourceId: string, externalId: string, contentHash: string, configHash: string): string {
  return hashValue([sourceId, externalId, contentHash, configHash].join('\n'))
}

export function makeDiscoveryKey(
  sourceId: string,
  externalId: string,
  canonicalUrl: string,
  configHash: string,
): string {
  return hashValue([sourceId, externalId, canonicalUrl, configHash].join('\n'))
}

export function pruneDecisions(state: DecisionState, maxRecords: number): void {
  if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new Error('maxRecords must be a positive integer')
  const entries = Object.entries(state.decisions).sort(([leftKey, left], [rightKey, right]) => {
    const difference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    return difference !== 0 ? difference : rightKey.localeCompare(leftKey)
  })
  state.decisions = Object.fromEntries(entries.slice(0, maxRecords))
  state.processedCandidates = Object.fromEntries(
    Object.entries(state.processedCandidates ?? {})
      .sort(([leftKey, left], [rightKey, right]) => {
        const difference = Date.parse(right) - Date.parse(left)
        return difference !== 0 ? difference : rightKey.localeCompare(leftKey)
      })
      .slice(0, maxRecords),
  )
}
