import { type Candidate, candidateReports } from './content'
import { hashValue } from './decisions'

export type SelectionPolicy = {
  readonly maxItemAgeHours: number
  readonly maxCandidatesPerRun: number
}

export type SelectionResult = {
  readonly candidates: readonly Candidate[]
  readonly deduplicated: number
  readonly tooOld: number
  readonly beforeCheckpoint: number
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

export function selectCandidates(
  collected: readonly Candidate[],
  sourceUrls: ReadonlyMap<string, string>,
  checkpoints: Readonly<Record<string, string>>,
  policy: SelectionPolicy,
  now: Date,
): SelectionResult {
  const unique = new Map<string, Candidate>()
  for (const candidate of collected) {
    const key = `${candidate.sourceId}:${candidate.externalId}:${candidateContentHash(candidate)}`
    if (!unique.has(key)) unique.set(key, candidate)
  }

  let tooOld = 0
  let beforeCheckpoint = 0
  const eligible = [...unique.values()].filter((candidate) => {
    const timestamp = publicationTime(candidate)
    const sourceUrl = sourceUrls.get(candidate.sourceId)
    const checkpoint = sourceUrl ? checkpoints[sourceUrl] : undefined

    if (timestamp === Number.NEGATIVE_INFINITY) {
      if (checkpoint) beforeCheckpoint += 1
      return !checkpoint
    }
    if (now.getTime() - timestamp > policy.maxItemAgeHours * 3_600_000) {
      tooOld += 1
      return false
    }
    if (checkpoint && timestamp <= Date.parse(checkpoint)) {
      beforeCheckpoint += 1
      return false
    }
    return true
  })

  eligible.sort((left, right) => {
    const timeDifference = publicationTime(right) - publicationTime(left)
    if (timeDifference !== 0) return timeDifference
    return `${left.sourceId}:${left.externalId}`.localeCompare(`${right.sourceId}:${right.externalId}`)
  })

  const candidates = eligible.slice(0, policy.maxCandidatesPerRun)
  return {
    candidates,
    deduplicated: unique.size,
    tooOld,
    beforeCheckpoint,
    skipped: eligible.length - candidates.length,
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
