import { type Candidate, type CandidateAdmission, candidateReports, type SourceReport } from './content'
import { hashValue, makeDiscoveryKey } from './decisions'

export type SelectionPolicy = {
  readonly maxItemAgeHours: number
  readonly maxCandidatesPerRun: number
}

export type SelectionResult = {
  readonly candidatePool: readonly Candidate[]
  readonly deduplicated: number
  readonly tooOld: number
  readonly beforeCheckpoint: number
  readonly alreadyProcessed: number
  readonly deferredSourceIds: ReadonlySet<string>
  readonly observedThrough: ReadonlyMap<string, string>
  readonly skipped: number
}

function normalizedContent(candidate: Candidate): string {
  return candidateReports(candidate)
    .map(
      (report) =>
        `${report.sourceId}\n${report.externalId}\n${report.canonicalUrl}\n${report.title}\n${report.content}`,
    )
    .sort()
    .join('\n---\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function candidateContentHash(candidate: Candidate): string {
  return hashValue(normalizedContent(candidate))
}

function publicationTime(candidate: Candidate): number {
  if (!candidate.publishedAt) return Number.NEGATIVE_INFINITY
  const timestamp = Date.parse(candidate.publishedAt)
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY
}

function reportKey(report: SourceReport): string {
  return `${report.sourceId}:${report.externalId}:${candidateContentHash(report)}`
}

function mergeCanonicalReports(reports: readonly SourceReport[]): Candidate[] {
  const groups = new Map<string, SourceReport[]>()
  for (const report of reports) {
    const current = groups.get(report.canonicalUrl)
    if (current) current.push(report)
    else groups.set(report.canonicalUrl, [report])
  }
  return [...groups.values()].map((group) => {
    group.sort((left, right) => {
      const difference = publicationTime(right) - publicationTime(left)
      return difference !== 0
        ? difference
        : `${left.sourceId}:${left.externalId}`.localeCompare(`${right.sourceId}:${right.externalId}`)
    })
    const primary = group[0]
    if (!primary) throw new Error('Canonical report group must not be empty')
    return group.length === 1 ? primary : { ...primary, reports: group }
  })
}

function balancedPool(candidates: readonly Candidate[], limit: number): Candidate[] {
  const queues = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const queue = queues.get(candidate.sourceId)
    if (queue) queue.push(candidate)
    else queues.set(candidate.sourceId, [candidate])
  }
  for (const queue of queues.values())
    queue.sort((left, right) => {
      const difference = publicationTime(right) - publicationTime(left)
      return difference !== 0
        ? difference
        : `${left.sourceId}:${left.externalId}`.localeCompare(`${right.sourceId}:${right.externalId}`)
    })

  const selected: Candidate[] = []
  while (selected.length < limit) {
    const activeSources = [...queues.entries()]
      .filter((entry): entry is [string, Candidate[]] => entry[1][0] !== undefined)
      .sort(([leftSource, leftQueue], [rightSource, rightQueue]) => {
        const left = leftQueue[0]
        const right = rightQueue[0]
        if (!left || !right) return leftSource.localeCompare(rightSource)
        const difference = publicationTime(right) - publicationTime(left)
        return difference !== 0 ? difference : leftSource.localeCompare(rightSource)
      })
    if (activeSources.length === 0) break
    for (const [, queue] of activeSources) {
      const candidate = queue.shift()
      if (candidate) selected.push(candidate)
      if (selected.length === limit) break
    }
  }
  return selected
}

function normalizedCategory(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase() || 'general'
}

export function selectAdmittedCandidates(
  candidates: readonly Candidate[],
  admissions: readonly CandidateAdmission[],
  limit: number,
): readonly Candidate[] {
  if (candidates.length <= limit) return candidates
  const byIndex = new Map(admissions.map((admission) => [admission.index, admission]))
  if (
    byIndex.size !== candidates.length ||
    admissions.some((admission) => admission.index < 0 || admission.index >= candidates.length)
  )
    throw new Error('AI admission must assess every candidate index exactly once')

  const ranked = candidates
    .map((candidate, index) => ({ candidate, admission: byIndex.get(index) }))
    .filter((item): item is { candidate: Candidate; admission: CandidateAdmission } => item.admission !== undefined)
    .sort((left, right) => {
      const scoreDifference = right.admission.score - left.admission.score
      if (scoreDifference !== 0) return scoreDifference
      const timeDifference = publicationTime(right.candidate) - publicationTime(left.candidate)
      return timeDifference !== 0
        ? timeDifference
        : `${left.candidate.sourceId}:${left.candidate.externalId}`.localeCompare(
            `${right.candidate.sourceId}:${right.candidate.externalId}`,
          )
    })
  const sourceLimit = Math.max(
    1,
    Math.ceil(limit / Math.min(limit, new Set(ranked.map((item) => item.candidate.sourceId)).size)),
  )
  const categoryLimit = Math.max(1, Math.ceil(limit / 2))
  const sourceCounts = new Map<string, number>()
  const categoryCounts = new Map<string, number>()
  const selected: typeof ranked = []
  const deferred: typeof ranked = []
  for (const item of ranked) {
    const category = normalizedCategory(item.admission.category)
    if (
      (sourceCounts.get(item.candidate.sourceId) ?? 0) >= sourceLimit ||
      (categoryCounts.get(category) ?? 0) >= categoryLimit
    ) {
      deferred.push(item)
      continue
    }
    selected.push(item)
    sourceCounts.set(item.candidate.sourceId, (sourceCounts.get(item.candidate.sourceId) ?? 0) + 1)
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)
    if (selected.length === limit) break
  }
  if (selected.length < limit) {
    const selectedCandidates = new Set(selected.map((item) => item.candidate))
    for (const item of [...ranked, ...deferred]) {
      if (selectedCandidates.has(item.candidate)) continue
      selected.push(item)
      selectedCandidates.add(item.candidate)
      if (selected.length === limit) break
    }
  }
  return selected.map((item) => item.candidate)
}

export function selectCandidates(
  collected: readonly Candidate[],
  sourceUrls: ReadonlyMap<string, string>,
  checkpoints: Readonly<Record<string, string>>,
  processedCandidateKeys: ReadonlySet<string>,
  configHash: string,
  policy: SelectionPolicy,
  now: Date,
): SelectionResult {
  const unique = new Map<string, SourceReport>()
  for (const candidate of collected) {
    for (const report of candidateReports(candidate)) {
      const key = reportKey(report)
      if (!unique.has(key)) unique.set(key, report)
    }
  }

  let tooOld = 0
  let beforeCheckpoint = 0
  let alreadyProcessed = 0
  const observedThrough = new Map<string, string>()
  const eligibleReports = [...unique.values()].filter((report) => {
    const timestamp = publicationTime(report)
    const sourceUrl = sourceUrls.get(report.sourceId)
    const checkpoint = sourceUrl ? checkpoints[sourceUrl] : undefined

    if (timestamp === Number.NEGATIVE_INFINITY) {
      if (checkpoint) beforeCheckpoint += 1
      if (checkpoint) return false
    } else {
      if (now.getTime() - timestamp > policy.maxItemAgeHours * 3_600_000) {
        tooOld += 1
        return false
      }
      if (checkpoint && timestamp <= Date.parse(checkpoint)) {
        beforeCheckpoint += 1
        return false
      }
      const previous = observedThrough.get(report.sourceId)
      if (report.publishedAt && (!previous || timestamp > Date.parse(previous)))
        observedThrough.set(report.sourceId, report.publishedAt)
    }
    if (
      processedCandidateKeys.has(makeDiscoveryKey(report.sourceId, report.externalId, report.canonicalUrl, configHash))
    ) {
      alreadyProcessed += 1
      return false
    }
    return true
  })
  const eligible = mergeCanonicalReports(eligibleReports)
  const poolLimit = Math.min(500, Math.max(policy.maxCandidatesPerRun, policy.maxCandidatesPerRun * 4))
  const candidatePool = balancedPool(eligible, poolLimit)
  const pooled = new Set(candidatePool)
  const deferredSourceIds = new Set(
    eligible
      .filter((candidate) => !pooled.has(candidate))
      .flatMap((candidate) => candidateReports(candidate).map((report) => report.sourceId)),
  )
  return {
    candidatePool,
    deduplicated: unique.size,
    tooOld,
    beforeCheckpoint,
    alreadyProcessed,
    deferredSourceIds,
    observedThrough,
    skipped: Math.max(0, eligible.length - policy.maxCandidatesPerRun),
  }
}

export function isReservedTestSource(candidate: Candidate): boolean {
  try {
    const hostname = new URL(candidate.canonicalUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      ['127.0.0.1', '::1', '0.0.0.0', 'example', 'invalid', 'test'].includes(hostname) ||
      ['.example', '.invalid', '.test'].some((suffix) => hostname.endsWith(suffix))
    )
  } catch {
    return false
  }
}
