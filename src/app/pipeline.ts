import type { AppConfig } from '../config/model'
import type { Article, Candidate, PublicationReference } from '../domain/content'
import {
  type DecisionRecord,
  type DecisionState,
  hashValue,
  makeDecisionKey,
  pruneDecisions,
} from '../domain/decisions'
import { candidateContentHash, isReservedTestSource, selectCandidates } from '../domain/selection'
import type { PipelinePorts } from './ports'

export type RunSummary = {
  collected: number
  deduplicated: number
  tooOld: number
  beforeCheckpoint: number
  selected: number
  skipped: number
  alreadyDecided: number
  filtered: number
  gateEvaluated: number
  rejected: number
  failed: number
  generated: number
  published: number
  deliveriesSent: number
  deliveriesFailed: number
  deliveriesDiscarded: number
  deliveriesPending: number
  sourceErrors: number
  targetCommitSha?: string
}

export type RunOptions = {
  readonly mode?: 'run' | 'initial' | 'bootstrap'
  readonly allowTestSources?: boolean
  readonly now?: Date
}

type Counters = {
  alreadyDecided: number
  filtered: number
  gateEvaluated: number
  rejected: number
  failed: number
  generated: number
}

type RunContext = {
  readonly config: AppConfig
  readonly ports: PipelinePorts
  readonly state: DecisionState
  readonly publishedKeys: ReadonlySet<string>
  readonly seenKeys: Set<string>
  readonly counters: Counters
  readonly failedSources: Set<string>
  readonly configHash: string
  readonly updatedAt: string
  readonly allowTestSources: boolean
}

const emptyCounters = (): Counters => ({
  alreadyDecided: 0,
  filtered: 0,
  gateEvaluated: 0,
  rejected: 0,
  failed: 0,
  generated: 0,
})

function configurationHash(config: AppConfig): string {
  // Editorial choices are part of identity so a deliberate configuration change can reconsider old material.
  return hashValue(
    JSON.stringify({
      provider: config.ai.provider,
      model: config.ai.model,
      threshold: config.editorial.publishThreshold,
      deduplicationContextSize: config.editorial.deduplicationContextSize,
      minimumContentLength: config.sources.minimumContentLength,
      languages: config.editorial.languages,
      instructions: config.editorial.instructions,
      prompts: { gate: config.editorial.gatePrompt, article: config.editorial.articlePrompt },
    }),
  )
}

function decisionRecord(
  decisionKey: string,
  status: DecisionRecord['status'],
  configHash: string,
  updatedAt: string,
  details: Pick<DecisionRecord, 'reason' | 'score' | 'targetCommitSha' | 'candidateTitle' | 'canonicalUrl'> = {},
): DecisionRecord {
  return { decisionKey, status, configHash, updatedAt, ...details }
}

function recentPublications(state: DecisionState, limit: number): PublicationReference[] {
  if (limit === 0) return []
  return Object.values(state.decisions)
    .flatMap((record) => {
      if (
        !['generated', 'published'].includes(record.status) ||
        record.candidateTitle === undefined ||
        record.canonicalUrl === undefined
      )
        return []
      return [
        {
          decisionKey: record.decisionKey,
          title: record.candidateTitle,
          canonicalUrl: record.canonicalUrl,
          publishedAt: record.updatedAt,
        },
      ]
    })
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    .slice(0, limit)
}

function bootstrapSummary(targetCommitSha?: string): RunSummary {
  return {
    collected: 0,
    deduplicated: 0,
    tooOld: 0,
    beforeCheckpoint: 0,
    selected: 0,
    skipped: 0,
    alreadyDecided: 0,
    filtered: 0,
    gateEvaluated: 0,
    rejected: 0,
    failed: 0,
    generated: 0,
    published: 0,
    deliveriesSent: 0,
    deliveriesFailed: 0,
    deliveriesDiscarded: 0,
    deliveriesPending: 0,
    sourceErrors: 0,
    targetCommitSha,
  }
}

async function processCandidate(candidate: Candidate, context: RunContext): Promise<readonly Article[]> {
  const { config, ports, state, publishedKeys, seenKeys, counters, failedSources, configHash, updatedAt } = context
  const decisionKey = makeDecisionKey(
    candidate.sourceId,
    candidate.externalId,
    candidateContentHash(candidate),
    configHash,
  )
  const previous = state.decisions[decisionKey]
  if ((previous && previous.status !== 'failed') || publishedKeys.has(decisionKey) || seenKeys.has(decisionKey)) {
    counters.alreadyDecided += 1
    return []
  }
  seenKeys.add(decisionKey)

  let filterReason: string | undefined
  if (!context.allowTestSources && isReservedTestSource(candidate)) filterReason = 'reserved-test-source'
  else if (candidate.content.trim().length < config.sources.minimumContentLength) filterReason = 'content-too-short'
  if (filterReason) {
    counters.filtered += 1
    state.decisions[decisionKey] = decisionRecord(decisionKey, 'rejected', configHash, updatedAt, {
      reason: filterReason,
    })
    return []
  }

  counters.gateEvaluated += 1
  try {
    const gate = await ports.editorial.evaluate(
      candidate,
      recentPublications(state, config.editorial.deduplicationContextSize),
    )
    if (!gate.publish) {
      counters.rejected += 1
      state.decisions[decisionKey] = decisionRecord(decisionKey, 'rejected', configHash, updatedAt, {
        reason: gate.reason,
        score: gate.score,
      })
      return []
    }

    const generated = await ports.editorial.generate(candidate, gate)
    counters.generated += generated.length
    state.decisions[decisionKey] = decisionRecord(decisionKey, 'generated', configHash, updatedAt, {
      reason: gate.reason,
      score: gate.score,
      candidateTitle: candidate.title,
      canonicalUrl: candidate.canonicalUrl,
    })
    return generated.map((article) => ({
      ...article,
      decisionKey,
      publishedAt: updatedAt,
      score: gate.score,
      topics: gate.topics,
    }))
  } catch (error) {
    counters.failed += 1
    failedSources.add(candidate.sourceId)
    state.decisions[decisionKey] = decisionRecord(decisionKey, 'failed', configHash, updatedAt, {
      reason: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

async function publish(articles: readonly Article[], context: RunContext): Promise<string | undefined> {
  const { config, ports, state, configHash, updatedAt } = context
  try {
    const requiredDeliveries = articles.length * ports.delivery.length
    if (state.pendingDeliveries.length + requiredDeliveries > config.state.maxPendingDeliveries)
      throw new Error('Pending delivery queue is full')
    const commit = await ports.site.publish(articles, 'content')
    if (!commit) {
      if (articles.length > 0) throw new Error('Target publish produced no commit')
      return undefined
    }
    for (const article of articles) {
      const previous = state.decisions[article.decisionKey]
      state.decisions[article.decisionKey] = decisionRecord(article.decisionKey, 'published', configHash, updatedAt, {
        reason: previous?.reason,
        score: previous?.score,
        targetCommitSha: commit,
        candidateTitle: previous?.candidateTitle,
        canonicalUrl: previous?.canonicalUrl,
      })
      for (const channel of ports.delivery) {
        state.pendingDeliveries.push({
          id: hashValue(`${channel.id}\n${article.decisionKey}\n${article.language}`),
          channelId: channel.id,
          article: {
            language: article.language,
            title: article.title,
            summary: article.summary,
            sourceUrls: article.sourceUrls,
          },
          createdAt: updatedAt,
          attempts: 0,
        })
      }
    }
    await ports.decisions.save(state)
    return commit
  } catch (error) {
    for (const article of articles)
      state.decisions[article.decisionKey] = decisionRecord(article.decisionKey, 'failed', configHash, updatedAt, {
        reason: error instanceof Error ? error.message : String(error),
      })
    pruneDecisions(state, config.state.maxRecords)
    await ports.decisions.save(state)
    throw error
  }
}

async function deliverPending(context: RunContext): Promise<{ sent: number; failed: number; discarded: number }> {
  const channels = new Map(context.ports.delivery.map((channel) => [channel.id, channel]))
  let sent = 0
  let failed = 0
  let discarded = 0
  for (const pending of [...context.state.pendingDeliveries]) {
    const channel = channels.get(pending.channelId)
    if (!channel) {
      context.state.pendingDeliveries = context.state.pendingDeliveries.filter(
        (candidate) => candidate.id !== pending.id,
      )
      await context.ports.decisions.save(context.state)
      discarded += 1
      continue
    }
    pending.attempts += 1
    try {
      await channel.send(pending.article)
      context.state.pendingDeliveries = context.state.pendingDeliveries.filter(
        (candidate) => candidate.id !== pending.id,
      )
      sent += 1
    } catch {
      pending.lastError = `Delivery channel ${channel.id} failed`
      failed += 1
    }
    await context.ports.decisions.save(context.state)
  }
  return { sent, failed, discarded }
}

export async function runPipeline(
  config: AppConfig,
  ports: PipelinePorts,
  options: RunOptions = {},
): Promise<RunSummary> {
  if (options.mode === 'bootstrap') return bootstrapSummary(await ports.site.publish([], 'bootstrap'))

  const now = options.now ?? new Date()
  const updatedAt = now.toISOString()
  const configHash = configurationHash(config)
  const state = await ports.decisions.load()
  const publishedKeys = await ports.site.publishedDecisionKeys()
  const collection = await ports.sources.collect()
  const sourceUrls = new Map(config.sources.entries.map((source) => [source.id, source.url]))
  // A configuration change starts from the recent edge again; old checkpoints describe a different editorial policy.
  const checkpoints = state.configHash && state.configHash !== configHash ? {} : state.sourceCheckpoints
  const selection = selectCandidates(collection.candidates, sourceUrls, checkpoints, config.sources, now)

  const context: RunContext = {
    config,
    ports,
    state,
    publishedKeys,
    seenKeys: new Set(),
    counters: emptyCounters(),
    failedSources: new Set(collection.errors.map((error) => error.sourceId)),
    configHash,
    updatedAt,
    allowTestSources: options.allowTestSources ?? false,
  }
  const previousDelivery = await deliverPending(context)
  const articles: Article[] = []
  for (const candidate of selection.candidates) {
    articles.push(...(await processCandidate(candidate, context)))
  }

  if (options.mode === 'initial' && articles.length === 0)
    throw new Error(
      'Initial deployment requires at least one validated article, but no candidate passed the publication gate',
    )

  const commit = await publish(articles, context)
  const currentDelivery = await deliverPending(context)
  for (const source of config.sources.entries) {
    // The checkpoint intentionally drops unselected older candidates; each run follows the newest edge, not a backlog.
    if (!context.failedSources.has(source.id)) state.sourceCheckpoints[source.url] = updatedAt
  }
  if (context.failedSources.size === 0) state.lastRunAt = updatedAt
  state.configHash = configHash
  pruneDecisions(state, config.state.maxRecords)
  await ports.decisions.save(state)

  return {
    collected: collection.candidates.length,
    deduplicated: selection.deduplicated,
    tooOld: selection.tooOld,
    beforeCheckpoint: selection.beforeCheckpoint,
    selected: selection.candidates.length,
    skipped: selection.skipped,
    ...context.counters,
    published: commit ? articles.length : 0,
    deliveriesSent: previousDelivery.sent + currentDelivery.sent,
    deliveriesFailed: previousDelivery.failed + currentDelivery.failed,
    deliveriesDiscarded: previousDelivery.discarded + currentDelivery.discarded,
    deliveriesPending: state.pendingDeliveries.length,
    sourceErrors: collection.errors.length,
    targetCommitSha: commit,
  }
}
