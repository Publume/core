import type { AppConfig } from '../config/model'
import {
  type Article,
  type Candidate,
  candidateReports,
  type EvidenceCollectionResult,
  type GateDecision,
  type GeneratedArticle,
  type ModelCall,
  type PublicationReference,
  type SourceReport,
} from '../domain/content'
import {
  type DecisionRecord,
  type DecisionState,
  hashValue,
  makeDecisionKey,
  makeDiscoveryKey,
  pruneDecisions,
} from '../domain/decisions'
import {
  candidateContentHash,
  isReservedTestSource,
  selectAdmittedCandidates,
  selectCandidates,
} from '../domain/selection'
import { normalizeTopics } from '../domain/topics'
import type { PipelinePorts } from './ports'

export type RunSummary = {
  status: 'success' | 'partial' | 'noop'
  collected: number
  deduplicated: number
  tooOld: number
  beforeCheckpoint: number
  alreadyProcessed: number
  selected: number
  evidenceFetched: number
  evidenceErrors: number
  evidenceFailures: EvidenceCollectionResult['errors']
  enrichmentFetched: number
  enrichmentErrors: number
  storyGroups: number
  reportsMerged: number
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
  modelCalls: readonly ModelCall[]
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
  readonly publicationContext: readonly PublicationReference[]
}

type PreparedCandidate = {
  readonly candidate: Candidate
  readonly decisionKey: string
  readonly reports: readonly SourceReport[]
}

type CandidateOutcome =
  | { readonly kind: 'rejected'; readonly prepared: PreparedCandidate; readonly gate: GateDecision }
  | {
      readonly kind: 'generated'
      readonly prepared: PreparedCandidate
      readonly gate: GateDecision
      readonly generated: readonly GeneratedArticle[]
      readonly topics: ReturnType<typeof normalizeTopics>
    }
  | { readonly kind: 'failed'; readonly prepared: PreparedCandidate; readonly reason: string }

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
      enrichmentSearchUrlTemplate: config.sources.enrichmentSearchUrlTemplate,
      languages: config.editorial.languages,
      instructions: config.editorial.instructions,
      prompts: { gate: config.editorial.gatePrompt, article: config.editorial.articlePrompt },
      editorialProfile: config.editorial.profile,
      evidenceContract: 1,
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
    status: 'success',
    collected: 0,
    deduplicated: 0,
    tooOld: 0,
    beforeCheckpoint: 0,
    alreadyProcessed: 0,
    selected: 0,
    evidenceFetched: 0,
    evidenceErrors: 0,
    evidenceFailures: [],
    enrichmentFetched: 0,
    enrichmentErrors: 0,
    storyGroups: 0,
    reportsMerged: 0,
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
    modelCalls: [],
    targetCommitSha,
  }
}

function markProcessed(prepared: PreparedCandidate, context: RunContext): void {
  context.state.processedCandidates ??= {}
  const processedCandidates = context.state.processedCandidates
  for (const report of prepared.reports)
    processedCandidates[makeDiscoveryKey(report.sourceId, report.externalId, report.canonicalUrl, context.configHash)] =
      context.updatedAt
}

function prepareCandidate(candidate: Candidate, context: RunContext): PreparedCandidate | undefined {
  const { config, state, publishedKeys, seenKeys, counters, configHash, updatedAt } = context
  const decisionKey = makeDecisionKey(
    candidate.sourceId,
    candidate.externalId,
    candidateContentHash(candidate),
    configHash,
  )
  const previous = state.decisions[decisionKey]
  if ((previous && previous.status !== 'failed') || publishedKeys.has(decisionKey) || seenKeys.has(decisionKey)) {
    counters.alreadyDecided += 1
    return undefined
  }
  seenKeys.add(decisionKey)

  let filterReason: string | undefined
  const reports = candidateReports(candidate)
  const evidenceReports = reports.filter((report) => report.contentOrigin === 'article-page')
  if (!context.allowTestSources && reports.some(isReservedTestSource)) filterReason = 'reserved-test-source'
  else if (evidenceReports.length === 0) filterReason = 'evidence-unavailable'
  else if (evidenceReports.every((report) => report.content.trim().length < config.sources.minimumContentLength))
    filterReason = 'content-too-short'
  if (filterReason) {
    if (filterReason === 'evidence-unavailable') {
      counters.failed += 1
      for (const report of reports) context.failedSources.add(report.sourceId)
      state.decisions[decisionKey] = decisionRecord(decisionKey, 'failed', configHash, updatedAt, {
        reason: filterReason,
      })
    } else {
      counters.filtered += 1
      state.decisions[decisionKey] = decisionRecord(decisionKey, 'rejected', configHash, updatedAt, {
        reason: filterReason,
      })
      markProcessed({ candidate, decisionKey, reports }, context)
    }
    return undefined
  }

  counters.gateEvaluated += 1
  return { candidate, decisionKey, reports }
}

async function evaluateCandidate(prepared: PreparedCandidate, context: RunContext): Promise<CandidateOutcome> {
  const { candidate } = prepared
  try {
    const gate = await context.ports.editorial.evaluate(candidate, context.publicationContext)
    if (!gate.publish) return { kind: 'rejected', prepared, gate }
    const generated = await context.ports.editorial.generate(candidate, gate)
    const topics = normalizeTopics(gate.topics)
    return { kind: 'generated', prepared, gate, generated, topics }
  } catch (error) {
    return {
      kind: 'failed',
      prepared,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

function applyCandidateOutcome(outcome: CandidateOutcome, context: RunContext): readonly Article[] {
  const { candidate, decisionKey, reports } = outcome.prepared
  const { counters, failedSources, state, configHash, updatedAt } = context
  if (outcome.kind === 'rejected') {
    counters.rejected += 1
    state.decisions[decisionKey] = decisionRecord(decisionKey, 'rejected', configHash, updatedAt, {
      reason: outcome.gate.reason,
      score: outcome.gate.score,
    })
    markProcessed(outcome.prepared, context)
    return []
  }
  if (outcome.kind === 'failed') {
    counters.failed += 1
    for (const report of reports) failedSources.add(report.sourceId)
    state.decisions[decisionKey] = decisionRecord(decisionKey, 'failed', configHash, updatedAt, {
      reason: outcome.reason,
    })
    return []
  }

  counters.generated += outcome.generated.length
  state.decisions[decisionKey] = decisionRecord(decisionKey, 'generated', configHash, updatedAt, {
    reason: outcome.gate.reason,
    score: outcome.gate.score,
    candidateTitle: candidate.title,
    canonicalUrl: candidate.canonicalUrl,
  })
  return outcome.generated.map((article) => ({
    ...article,
    decisionKey,
    publishedAt: updatedAt,
    score: outcome.gate.score,
    topics: outcome.topics.labels,
    topicIds: outcome.topics.ids,
  }))
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  task: (value: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const results = new Array<Output>(values.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      const value = values[index]
      if (value !== undefined) results[index] = await task(value)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return results
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
      await channel.send(pending.article, pending.id)
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

async function executePipeline(config: AppConfig, ports: PipelinePorts, options: RunOptions = {}): Promise<RunSummary> {
  if (options.mode === 'bootstrap') return bootstrapSummary(await ports.site.publish([], 'bootstrap'))

  const now = options.now ?? new Date()
  const updatedAt = now.toISOString()
  const configHash = configurationHash(config)
  const state = await ports.decisions.load()
  const [publishedKeysResult, collectionResult] = await Promise.allSettled([
    ports.site.publishedDecisionKeys(),
    ports.sources.collect(),
  ])
  if (publishedKeysResult.status === 'rejected') throw publishedKeysResult.reason
  if (collectionResult.status === 'rejected') throw collectionResult.reason
  const publishedKeys = publishedKeysResult.value
  const collection = collectionResult.value
  if (collection.candidates.length === 0 && collection.errors.length === config.sources.entries.length)
    throw new Error('All configured sources failed')
  const sourceUrls = new Map(config.sources.entries.map((source) => [source.id, source.url]))
  // A configuration change starts from the recent edge again; old checkpoints describe a different editorial policy.
  const checkpoints = state.configHash && state.configHash !== configHash ? {} : state.sourceCheckpoints
  const selection = selectCandidates(
    collection.candidates,
    sourceUrls,
    checkpoints,
    new Set(Object.keys(state.processedCandidates ?? {})),
    configHash,
    config.sources,
    now,
  )

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
    // Consolidation owns same-run event grouping; gates compare against one stable cross-run publication snapshot.
    publicationContext: recentPublications(state, config.editorial.deduplicationContextSize),
  }
  const previousDelivery = await deliverPending(context)
  const admissions =
    selection.candidatePool.length > config.sources.maxCandidatesPerRun
      ? await ports.editorial.admit(selection.candidatePool)
      : []
  const selected = selectAdmittedCandidates(selection.candidatePool, admissions, config.sources.maxCandidatesPerRun)
  const deferredSourceIds = new Set(selection.deferredSourceIds)
  const selectedSet = new Set(selected)
  for (const candidate of selection.candidatePool) {
    if (selectedSet.has(candidate)) continue
    for (const report of candidateReports(candidate)) deferredSourceIds.add(report.sourceId)
  }
  const evidence = await ports.sources.collectEvidence(selected)
  for (const error of evidence.errors) context.failedSources.add(error.sourceId)
  const enrichmentTargets =
    config.sources.enrichmentSearchUrlTemplate &&
    config.editorial.profile.storyBlocks.some((block) => block.tools?.includes('web-search')) &&
    ports.sources.collectEnrichment
      ? evidence.candidates
          .filter(
            (candidate) =>
              new Set(
                candidateReports(candidate)
                  .filter((report) => report.contentOrigin === 'article-page')
                  .map((report) => report.canonicalUrl),
              ).size < config.editorial.profile.minimumEvidenceSources,
          )
          .slice(0, config.editorial.profile.maximumEnrichedStoriesPerRun)
      : []
  const enrichment =
    enrichmentTargets.length > 0 && ports.sources.collectEnrichment
      ? await ports.sources.collectEnrichment(
          enrichmentTargets,
          config.editorial.profile.maximumEnrichmentResultsPerStory,
        )
      : { candidates: enrichmentTargets, errors: [], fetched: 0 }
  const enrichmentByCandidate = new Map(
    enrichmentTargets.map((candidate, index) => [candidate, enrichment.candidates[index] ?? candidate]),
  )
  const evidenceCandidates = evidence.candidates.map((candidate) => enrichmentByCandidate.get(candidate) ?? candidate)
  const evidenceReadyCandidates = evidenceCandidates.filter((candidate) =>
    candidateReports(candidate).some((report) => report.contentOrigin === 'article-page'),
  )
  const evidenceReady = new Set(evidenceReadyCandidates)
  for (const candidate of evidenceCandidates) {
    if (!evidenceReady.has(candidate)) prepareCandidate(candidate, context)
  }
  const stories = await ports.editorial.consolidate(evidenceReadyCandidates)
  const prepared = stories.flatMap((candidate) => {
    const item = prepareCandidate(candidate, context)
    return item ? [item] : []
  })
  const outcomes = await mapWithConcurrency(prepared, config.ai.concurrency, (candidate) =>
    evaluateCandidate(candidate, context),
  )
  const articles = outcomes.flatMap((outcome) => applyCandidateOutcome(outcome, context))

  const commit = await publish(articles, context)
  if (commit)
    for (const outcome of outcomes) {
      if (outcome.kind === 'generated') markProcessed(outcome.prepared, context)
    }
  const currentDelivery = await deliverPending(context)
  for (const source of config.sources.entries) {
    const observedThrough = selection.observedThrough.get(source.id)
    if (observedThrough && !context.failedSources.has(source.id) && !deferredSourceIds.has(source.id))
      state.sourceCheckpoints[source.url] = observedThrough
  }
  if (context.failedSources.size === 0) state.lastRunAt = updatedAt
  state.configHash = configHash
  pruneDecisions(state, config.state.maxRecords)
  await ports.decisions.save(state)

  const partial =
    collection.errors.length > 0 ||
    evidence.errors.length > 0 ||
    enrichment.errors.length > 0 ||
    context.counters.failed > 0 ||
    previousDelivery.failed + currentDelivery.failed > 0
  return {
    status: partial ? 'partial' : articles.length > 0 || (options.mode === 'initial' && commit) ? 'success' : 'noop',
    collected: collection.candidates.length,
    deduplicated: selection.deduplicated,
    tooOld: selection.tooOld,
    beforeCheckpoint: selection.beforeCheckpoint,
    alreadyProcessed: selection.alreadyProcessed,
    selected: selected.length,
    evidenceFetched: evidence.fetched,
    evidenceErrors: evidence.errors.length,
    evidenceFailures: evidence.errors,
    enrichmentFetched: enrichment.fetched,
    enrichmentErrors: enrichment.errors.length,
    storyGroups: stories.length,
    reportsMerged: evidenceReadyCandidates.length - stories.length,
    skipped: Math.max(0, selection.skipped),
    ...context.counters,
    published: commit ? articles.length : 0,
    deliveriesSent: previousDelivery.sent + currentDelivery.sent,
    deliveriesFailed: previousDelivery.failed + currentDelivery.failed,
    deliveriesDiscarded: previousDelivery.discarded + currentDelivery.discarded,
    deliveriesPending: state.pendingDeliveries.length,
    sourceErrors: collection.errors.length,
    modelCalls: ports.editorial.provenance?.() ?? [],
    targetCommitSha: commit,
  }
}

export async function runPipeline(
  config: AppConfig,
  ports: PipelinePorts,
  options: RunOptions = {},
): Promise<RunSummary> {
  try {
    return await executePipeline(config, ports, options)
  } finally {
    await ports.site.close()
  }
}
