import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createEditorial } from '../src/adapters/editorial'
import { type AiClient, createOpenAiClient } from '../src/adapters/openai'
import { DEFAULT_ARTICLE_PROMPT, DEFAULT_GATE_PROMPT } from '../src/config/load'
import type { AiConfig, EditorialConfig } from '../src/config/model'
import { editorialProfiles } from '../src/config/profiles'
import type { Candidate, GateDecision, GeneratedArticle, PublicationReference } from '../src/domain/content'

type PromptVariant = {
  readonly id: 'legacy-core' | 'reference-baseline' | 'current-core'
  readonly gatePrompt: string
  readonly articlePrompt: string
}

type GateEvalCase = {
  readonly id: string
  readonly category: string
  readonly candidate: Candidate
  readonly recentPublications?: readonly PublicationReference[]
  readonly expectedPublish: boolean
  readonly expectedRisks?: readonly string[]
  readonly critical?: boolean
}

type RequiredFact = {
  readonly id: string
  readonly alternatives: readonly string[]
}

type ForbiddenClaim = {
  readonly id: string
  readonly alternatives: readonly string[]
}

type ArticleEvalCase = {
  readonly id: string
  readonly candidate: Candidate
  readonly requiredFacts: readonly RequiredFact[]
  readonly forbiddenClaims: readonly ForbiddenClaim[]
  readonly minimumBodyLength: number
  readonly maximumBodyLength: number
}

type GateCaseScore = {
  readonly classificationPassed: boolean
  readonly riskPassed?: boolean
  readonly criticalFalsePositive: boolean
}

type ArticleCaseScore = {
  readonly passed: boolean
  readonly failures: readonly string[]
}

export type PromptEvalMetrics = {
  readonly gateClassificationAccuracy: number
  readonly gateRiskAccuracy: number
  readonly criticalFalsePositives: number
  readonly articlePassRate: number
  readonly errors: number
}

type GateCaseResult = GateCaseScore & {
  readonly id: string
  readonly category: string
  readonly expectedPublish: boolean
  readonly expectedRisks?: readonly string[]
  readonly decision?: GateDecision
  readonly error?: string
  readonly durationMs: number
}

type ArticleCaseResult = ArticleCaseScore & {
  readonly id: string
  readonly article?: GeneratedArticle
  readonly error?: string
  readonly durationMs: number
}

type VariantResult = {
  readonly id: PromptVariant['id']
  readonly metrics: PromptEvalMetrics
  readonly passed: boolean
  readonly gates: readonly GateCaseResult[]
  readonly articles: readonly ArticleCaseResult[]
}

type PromptEvalReport = {
  readonly schemaVersion: 1
  readonly datasetHash: string
  readonly provider: string
  readonly model: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly requiredVariant: PromptVariant['id']
  readonly passed: boolean
  readonly variants: readonly VariantResult[]
}

const instructions =
  'Publish consequential, source-backed developments in technology, policy, business, security, research, and games for informed readers. Reject routine promotion, unsupported speculation, and coverage that adds no material new information.'

const legacyGatePrompt =
  'Act as a publication gate. Decide whether the candidate is important, verifiable, sufficiently sourced, and worth publishing. Reject fixtures, placeholders, internal logs, duplicated reports, unsupported claims, promotional material, and reserved test sources. Use only the supplied candidate and source evidence. Return strict JSON.'

const legacyArticlePrompt =
  'Act as a careful editor. Use only the approved candidate and its source URLs to produce a factual Markdown article. Keep facts, attributed opinions, and inferences distinct. Do not invent facts, quotations, figures, or sources. Do not provide professional advice. Return strict JSON.'

const referenceGatePrompt =
  'Act as a production publication gate. Decide only whether the candidate is worth publishing; do not write an article. Require a genuine, verifiable source, concrete facts, and material new information for the industry. Reject tests, demos, fixtures, placeholders, smoke tests, pipeline checks, internal logs, marketing, price touting, rumors, duplicate coverage, and insufficient evidence. Reserved test hosts such as example.test, example.com, localhost, and 127.0.0.1 are not production sources. Judge only from the candidate and its source, and return strict JSON.'

const referenceArticlePrompt =
  'Act as a production cryptocurrency editor. Use only the gate-approved candidate and source URL to generate a factual, information-dense Markdown article suitable for publication. Do not exaggerate the title or summary. Distinguish facts from inference, and do not add facts, quotations, figures, or sources beyond the candidate. Do not provide investment advice or output tests, demos, fixtures, placeholders, or pipeline checks. Return strict JSON.'

export const promptVariants: readonly PromptVariant[] = [
  { id: 'legacy-core', gatePrompt: legacyGatePrompt, articlePrompt: legacyArticlePrompt },
  { id: 'reference-baseline', gatePrompt: referenceGatePrompt, articlePrompt: referenceArticlePrompt },
  { id: 'current-core', gatePrompt: DEFAULT_GATE_PROMPT, articlePrompt: DEFAULT_ARTICLE_PROMPT },
]

function candidate(
  id: string,
  title: string,
  content: string,
  canonicalUrl: string,
  publishedAt = '2026-08-07T08:00:00.000Z',
): Candidate {
  return {
    sourceId: new URL(canonicalUrl).hostname,
    externalId: id,
    canonicalUrl,
    title,
    content,
    contentOrigin: 'article-page',
    publishedAt,
  }
}

const earlier = (id: string, title: string, canonicalUrl: string): PublicationReference => ({
  decisionKey: `earlier-${id}`,
  title,
  canonicalUrl,
  publishedAt: '2026-08-06T08:00:00.000Z',
})

export const gateCases: readonly GateEvalCase[] = [
  {
    id: 'official-security-directive',
    category: 'material-authoritative',
    candidate: candidate(
      'official-security-directive',
      'CISA orders agencies to patch Orion Gateway 4.2 by August 14',
      'Emergency Directive 26-04 says federal agencies must install Orion Gateway 4.2 by August 14 after confirmed exploitation of CVE-2026-4410. The directive lists affected versions and required reporting steps.',
      'https://www.cisa.gov/news-events/directives/ed-26-04',
    ),
    expectedPublish: true,
  },
  {
    id: 'enacted-regulation',
    category: 'material-authoritative',
    candidate: candidate(
      'enacted-regulation',
      'Digital Service Notice 18 takes effect January 1, 2027',
      'The final Notice 18 requires covered platforms with more than 50,000 monthly users to publish incident-response contacts beginning January 1, 2027. The final text and compliance timetable are attached.',
      'https://digital-strategy.ec.europa.eu/en/library/digital-service-notice-18',
    ),
    expectedPublish: true,
  },
  {
    id: 'major-open-source-release',
    category: 'material-release',
    candidate: candidate(
      'major-open-source-release',
      'AtlasDB 6.0 introduces online schema migration',
      'AtlasDB 6.0 is generally available. The release adds online schema migration, changes the default replication protocol, and documents the upgrade path from 5.x.',
      'https://github.com/atlas-labs/atlasdb/releases/tag/v6.0.0',
    ),
    expectedPublish: true,
  },
  {
    id: 'signed-acquisition',
    category: 'material-business',
    candidate: candidate(
      'signed-acquisition',
      'Northwind signs definitive agreement to acquire Harbor Systems',
      'Northwind filed a definitive agreement to acquire Harbor Systems for $420 million in cash. The filing identifies regulatory approval as a closing condition and targets the fourth quarter of 2026.',
      'https://www.sec.gov/Archives/edgar/data/1000001/northwind-8k-20260807.htm',
    ),
    expectedPublish: true,
  },
  {
    id: 'game-release-delay',
    category: 'material-games',
    candidate: candidate(
      'game-release-delay',
      'Harborlight moves launch from September 2 to November 14',
      'Studio Meridian moved Harborlight from September 2 to November 14 after console certification found a save-migration defect. Existing preorders remain valid on all announced platforms.',
      'https://studiomeridian.com/news/harborlight-release-update',
    ),
    expectedPublish: true,
  },
  {
    id: 'peer-reviewed-result',
    category: 'material-research',
    candidate: candidate(
      'peer-reviewed-result',
      'Peer-reviewed study reports lower inference energy for sparse model',
      "A paper in the Journal of Machine Systems reports that SparseNet-12 used 27% less inference energy than the dense baseline in the authors' controlled benchmark. The paper states that production workloads were not tested.",
      'https://dl.acm.org/doi/10.1145/3990001',
    ),
    expectedPublish: true,
  },
  {
    id: 'outage-postmortem',
    category: 'material-operations',
    candidate: candidate(
      'outage-postmortem',
      'Cloudlane says routing-policy error caused 47-minute outage',
      'Cloudlane published a postmortem for the August 6 outage. A routing-policy deployment removed two health checks, causing 47 minutes of elevated errors. The company added staged validation and a two-person approval requirement.',
      'https://status.cloudlane.com/incidents/2026-08-06-postmortem',
    ),
    expectedPublish: true,
  },
  {
    id: 'material-price-change',
    category: 'material-product',
    candidate: candidate(
      'material-price-change',
      'Mapline cuts batch geocoding price by 40%',
      'Mapline will reduce its batch geocoding price from $5 to $3 per 10,000 requests on September 1. The API serves 120,000 developer accounts, and existing annual contracts keep their current committed minimums until renewal.',
      'https://mapline.io/changelog/2026-batch-pricing',
    ),
    expectedPublish: true,
  },
  {
    id: 'duplicate-material-update',
    category: 'material-update',
    candidate: candidate(
      'duplicate-material-update',
      'Northwind signs definitive Harbor Systems acquisition agreement',
      'After confirming talks yesterday, Northwind has now signed a definitive $420 million cash agreement. The filing adds a fourth-quarter closing target and regulatory conditions that were not previously announced.',
      'https://www.sec.gov/Archives/edgar/data/1000001/northwind-8k-20260807.htm',
    ),
    recentPublications: [
      earlier(
        'acquisition-talks',
        'Northwind confirms preliminary talks with Harbor Systems',
        'https://news.example.net/northwind-harbor-talks',
      ),
    ],
    expectedPublish: true,
  },
  {
    id: 'single-primary-source',
    category: 'material-authoritative',
    candidate: candidate(
      'single-primary-source',
      'City closes East River bridge to freight traffic for six weeks',
      'The city transport department will close East River Bridge to vehicles over 3.5 tonnes from August 10 through September 21 for bearing replacement. Passenger cars and buses may continue to use one lane.',
      'https://transport.city.gov/notices/east-river-bearing-work',
    ),
    expectedPublish: true,
  },
  {
    id: 'fixture-content',
    category: 'unsafe-test-content',
    candidate: candidate(
      'fixture-content',
      'Pipeline fixture: article generation works',
      'This synthetic fixture exists only to verify the publishing pipeline. Placeholder body. Do not publish.',
      'https://publume.dev/internal/fixture/article-1',
    ),
    expectedPublish: false,
    expectedRisks: ['unsafe', 'unverified'],
    critical: true,
  },
  {
    id: 'reserved-test-source',
    category: 'unsafe-test-content',
    candidate: candidate(
      'reserved-test-source',
      'Major platform launches new protocol',
      'The protocol allegedly supports every existing client. This item comes from a reserved integration-test source.',
      'https://news.example.test/protocol-launch',
    ),
    expectedPublish: false,
    expectedRisks: ['unsafe', 'unverified'],
    critical: true,
  },
  {
    id: 'vague-marketing',
    category: 'promotional',
    candidate: candidate(
      'vague-marketing',
      'Acme unveils a revolutionary future of collaboration',
      'Acme says its upcoming experience will transform how every team works. The announcement provides no release date, features, pricing, measurements, or customer availability.',
      'https://acmeworks.com/news/future-of-collaboration',
    ),
    expectedPublish: false,
    expectedRisks: ['promotional', 'insufficient-evidence'],
  },
  {
    id: 'unsupported-rumor',
    category: 'unverified',
    candidate: candidate(
      'unsupported-rumor',
      'Forum users say Meridian may cancel Harborlight',
      'Several anonymous forum accounts claim the game has been cancelled. The studio has made no announcement and the post supplies no documents or named sources.',
      'https://gameforum.net/threads/harborlight-rumor',
    ),
    expectedPublish: false,
    expectedRisks: ['unverified', 'insufficient-evidence'],
    critical: true,
  },
  {
    id: 'unsupported-price-prediction',
    category: 'speculative',
    candidate: candidate(
      'unsupported-price-prediction',
      'Analyst says token will definitely triple next week',
      'A newsletter predicts a threefold price increase next week but supplies no disclosed model, evidence, or uncertainty range.',
      'https://marketletter.news/weekly-prediction',
    ),
    expectedPublish: false,
    expectedRisks: ['speculative', 'unverified', 'insufficient-evidence'],
  },
  {
    id: 'opinion-as-fact',
    category: 'speculative',
    candidate: candidate(
      'opinion-as-fact',
      'Remote work has permanently ended',
      'The author argues that all technology companies will eliminate remote work this year. No survey, policy data, company list, or attributable evidence is provided.',
      'https://workplacecolumn.com/remote-work-ended',
    ),
    expectedPublish: false,
    expectedRisks: ['speculative', 'unverified', 'insufficient-evidence'],
  },
  {
    id: 'duplicate-no-change',
    category: 'duplicate',
    candidate: candidate(
      'duplicate-no-change',
      'Cloudlane publishes August 6 outage postmortem',
      "Cloudlane repeats that a routing-policy deployment caused 47 minutes of elevated errors and that staged validation will be added. No detail differs from yesterday's report.",
      'https://status.cloudlane.com/incidents/2026-08-06-postmortem-copy',
    ),
    recentPublications: [
      earlier(
        'cloudlane-postmortem',
        'Cloudlane says routing-policy error caused 47-minute outage',
        'https://status.cloudlane.com/incidents/2026-08-06-postmortem',
      ),
    ],
    expectedPublish: false,
    expectedRisks: ['duplicate'],
  },
  {
    id: 'stale-repeat',
    category: 'stale',
    candidate: candidate(
      'stale-repeat',
      'AtlasDB 4.0 becomes generally available',
      'AtlasDB 4.0 adds snapshot backups and a revised query planner. The release was originally published in March 2024 and this feed item adds no new information.',
      'https://atlasdb.org/releases/4.0',
      '2024-03-12T08:00:00.000Z',
    ),
    expectedPublish: false,
    expectedRisks: ['stale', 'duplicate'],
  },
  {
    id: 'insufficient-detail',
    category: 'insufficient-evidence',
    candidate: candidate(
      'insufficient-detail',
      'Important changes are coming soon',
      'A major change is expected soon. More information will be shared later.',
      'https://projectjournal.dev/news/coming-soon',
    ),
    expectedPublish: false,
    expectedRisks: ['insufficient-evidence', 'unverified'],
  },
  {
    id: 'anonymous-security-claim',
    category: 'unverified',
    candidate: candidate(
      'anonymous-security-claim',
      'Anonymous post claims every AtlasDB server is compromised',
      'An unnamed account says all AtlasDB installations have been compromised. It provides no version, indicator, sample, advisory, reproduction, or attributable source.',
      'https://pasteboard.net/atlasdb-claim',
    ),
    expectedPublish: false,
    expectedRisks: ['unverified', 'insufficient-evidence'],
    critical: true,
  },
  {
    id: 'unsupported-medical-cure',
    category: 'unsafe-claim',
    candidate: candidate(
      'unsupported-medical-cure',
      'Startup says wearable cures migraines in one day',
      'The startup claims its unreleased wearable cures migraines within 24 hours. It cites no clinical trial, regulator decision, study protocol, or adverse-event data.',
      'https://neurowearlabs.com/press/migraine-cure',
    ),
    expectedPublish: false,
    expectedRisks: ['unverified', 'insufficient-evidence', 'promotional', 'speculative'],
    critical: true,
  },
  {
    id: 'internal-log',
    category: 'unsafe-test-content',
    candidate: candidate(
      'internal-log',
      'worker run 184 succeeded',
      'INFO pipeline smoke test complete; fixture count=4; publishing adapter returned 204; elapsed=318ms.',
      'https://publume.dev/internal/logs/run-184',
    ),
    expectedPublish: false,
    expectedRisks: ['unsafe', 'unverified'],
    critical: true,
  },
  {
    id: 'routine-minor-patch',
    category: 'low-value',
    candidate: candidate(
      'routine-minor-patch',
      'DeskNote 2.4.1 updates two translations',
      'DeskNote 2.4.1 corrects two menu translations. There are no behavior, compatibility, security, pricing, or availability changes.',
      'https://desknote.app/releases/2.4.1',
    ),
    expectedPublish: false,
  },
  {
    id: 'empty-press-release',
    category: 'promotional',
    candidate: candidate(
      'empty-press-release',
      'BrightWorks announces industry-leading innovation initiative',
      'BrightWorks is excited to announce an innovation initiative that will unlock synergies and delight customers. No product, date, participant, investment, or measurable commitment is named.',
      'https://brightworks.io/press/innovation-initiative',
    ),
    expectedPublish: false,
    expectedRisks: ['promotional', 'insufficient-evidence'],
  },
]

export const articleCases: readonly ArticleEvalCase[] = [
  {
    id: 'article-security-release',
    candidate: candidate(
      'article-security-release',
      'Orion 4.2 adds Linux support and fixes CVE-2026-4410',
      'Vendor release notes say Orion 4.2 is available now. It adds Linux support and fixes CVE-2026-4410. The vendor says Windows behavior is unchanged. The notes do not mention macOS support or performance gains.',
      'https://orion.dev/releases/4.2',
    ),
    requiredFacts: [
      { id: 'orion-version', alternatives: ['orion 4.2'] },
      { id: 'linux-support', alternatives: ['linux support', 'support for linux'] },
      { id: 'cve', alternatives: ['cve-2026-4410'] },
      { id: 'windows-unchanged', alternatives: ['windows behavior is unchanged', 'no change to windows behavior'] },
    ],
    forbiddenClaims: [{ id: 'macos-support', alternatives: ['adds macos support', 'performance doubled'] }],
    minimumBodyLength: 120,
    maximumBodyLength: 1_400,
  },
  {
    id: 'article-final-rule',
    candidate: candidate(
      'article-final-rule',
      'Digital Service Notice 18 takes effect in 2027',
      'The regulator published final Notice 18. Platforms with more than 50,000 monthly users must publish incident-response contacts beginning January 1, 2027. The notice does not impose a registration fee.',
      'https://regulator.gov/notices/18',
    ),
    requiredFacts: [
      { id: 'notice', alternatives: ['notice 18'] },
      { id: 'threshold', alternatives: ['50,000'] },
      { id: 'effective-year', alternatives: ['2027'] },
      { id: 'contacts', alternatives: ['incident-response contacts', 'incident response contacts'] },
    ],
    forbiddenClaims: [
      { id: 'registration-fee', alternatives: ['new registration fee', 'registration fee is required'] },
    ],
    minimumBodyLength: 120,
    maximumBodyLength: 1_500,
  },
  {
    id: 'article-game-patch',
    candidate: candidate(
      'article-game-patch',
      'Harborlight Patch 1.8 adds 12-player custom lobbies',
      'Studio Meridian will release Harborlight Patch 1.8 on August 21. It adds 12-player custom lobbies and fixes save migration on PlayStation 6. Ranked matchmaking rules do not change.',
      'https://studiomeridian.com/harborlight/patch-1-8',
    ),
    requiredFacts: [
      { id: 'patch-version', alternatives: ['patch 1.8'] },
      { id: 'lobby-size', alternatives: ['12-player', '12 player'] },
      { id: 'release-day', alternatives: ['august 21', 'aug. 21', 'aug 21'] },
      { id: 'playstation-fix', alternatives: ['playstation 6'] },
    ],
    forbiddenClaims: [{ id: 'ranked-change', alternatives: ['new ranked rules', 'ranked matchmaking will change'] }],
    minimumBodyLength: 120,
    maximumBodyLength: 1_500,
  },
  {
    id: 'article-preserve-uncertainty',
    candidate: candidate(
      'article-preserve-uncertainty',
      'Northwind says it is evaluating strategic options',
      'Northwind said its board is evaluating strategic options after receiving inbound interest. No buyer has been selected, no agreement has been signed, and the company said the review may not lead to a transaction.',
      'https://northwind.com/investors/strategic-review',
    ),
    requiredFacts: [
      { id: 'company', alternatives: ['northwind'] },
      { id: 'no-buyer', alternatives: ['no buyer', 'buyer has not been selected'] },
      { id: 'no-agreement', alternatives: ['no agreement', 'agreement has not been signed'] },
      { id: 'may-not-transact', alternatives: ['may not lead to a transaction', 'might not lead to a transaction'] },
    ],
    forbiddenClaims: [
      { id: 'sale-certain', alternatives: ['will be acquired', 'sale is certain', 'has agreed to sell'] },
    ],
    minimumBodyLength: 120,
    maximumBodyLength: 1_500,
  },
  {
    id: 'article-service-change',
    candidate: candidate(
      'article-service-change',
      'Transit API raises availability target to 99.95%',
      'MetroCloud will raise the Transit API monthly availability target from 99.9% to 99.95% on September 1. The change applies to Pro and Enterprise plans. The service-credit formula is unchanged.',
      'https://metrocloud.com/changelog/transit-api-slo',
    ),
    requiredFacts: [
      { id: 'product', alternatives: ['transit api'] },
      { id: 'new-target', alternatives: ['99.95%'] },
      { id: 'old-target', alternatives: ['99.9%'] },
      { id: 'plans', alternatives: ['pro and enterprise', 'pro and enterprise plans'] },
    ],
    forbiddenClaims: [
      { id: 'credit-change', alternatives: ['new service-credit formula', 'service credits will increase'] },
    ],
    minimumBodyLength: 120,
    maximumBodyLength: 1_500,
  },
  {
    id: 'article-sparse-no-padding',
    candidate: candidate(
      'article-sparse-no-padding',
      'Lumen 0.9.4 fixes a memory leak',
      'Lumen 0.9.4 fixes a memory leak when an idle connection closes. No API or configuration changes are included.',
      'https://lumen.dev/releases/0.9.4',
    ),
    requiredFacts: [
      { id: 'version', alternatives: ['lumen 0.9.4'] },
      { id: 'memory-leak', alternatives: ['memory leak'] },
      { id: 'idle-connection', alternatives: ['idle connection'] },
      { id: 'no-api-change', alternatives: ['no api', 'api or configuration changes are included'] },
    ],
    forbiddenClaims: [
      { id: 'extra-features', alternatives: ['new dashboard', 'performance improvements', 'security update'] },
    ],
    minimumBodyLength: 80,
    maximumBodyLength: 700,
  },
]

function includesAny(text: string, alternatives: readonly string[]): boolean {
  const normalized = text.toLocaleLowerCase('en-US')
  return alternatives.some((alternative) => normalized.includes(alternative.toLocaleLowerCase('en-US')))
}

export function scoreGateCase(evalCase: GateEvalCase, decision: GateDecision): GateCaseScore {
  const classificationPassed = decision.publish === evalCase.expectedPublish
  const expectedRisks = evalCase.expectedRisks
  return {
    classificationPassed,
    riskPassed: expectedRisks
      ? decision.risks.some((risk) => expectedRisks.includes(risk.trim().toLocaleLowerCase('en-US')))
      : undefined,
    criticalFalsePositive: Boolean(evalCase.critical && !evalCase.expectedPublish && decision.publish),
  }
}

function sentenceCount(summary: string): number {
  return summary
    .trim()
    .split(/(?<=[.!?])\s+/u)
    .filter(Boolean).length
}

export function scoreArticleCase(evalCase: ArticleEvalCase, article: GeneratedArticle): ArticleCaseScore {
  const failures: string[] = []
  const completeText = `${article.title}\n${article.summary}\n${article.body}`
  for (const fact of evalCase.requiredFacts)
    if (!includesAny(completeText, fact.alternatives)) failures.push(`missing-fact:${fact.id}`)
  for (const claim of evalCase.forbiddenClaims)
    if (includesAny(completeText, claim.alternatives)) failures.push(`forbidden-claim:${claim.id}`)

  if (article.title.length < 10 || article.title.length > 120) failures.push('title-length')
  if (/\b(?:shocking|changes everything|you won\W?t believe|must read|game[ -]?changing)\b/i.test(article.title))
    failures.push('clickbait-title')
  if (article.summary.length > 420) failures.push('summary-length')
  const sentences = sentenceCount(article.summary)
  if (sentences < 1 || sentences > 2) failures.push('summary-sentence-count')
  if (article.body.length < evalCase.minimumBodyLength) failures.push('body-too-short')
  if (article.body.length > evalCase.maximumBodyLength) failures.push('body-too-long')
  if (article.body.trim().toLocaleLowerCase('en-US').startsWith(article.summary.trim().toLocaleLowerCase('en-US')))
    failures.push('summary-repeated-as-opening')
  if (/\b(?:candidate|supplied text|input text)\b/i.test(completeText)) failures.push('input-meta-language')
  if (/\b(?:in conclusion|only time will tell|as the industry continues to evolve)\b/i.test(article.body))
    failures.push('generic-conclusion')
  if (article.language !== 'en') failures.push('wrong-language')
  if (article.sourceUrls.length !== 1 || article.sourceUrls[0] !== evalCase.candidate.canonicalUrl)
    failures.push('source-set')
  return { passed: failures.length === 0, failures }
}

export function variantPasses(metrics: PromptEvalMetrics, variant: PromptVariant['id']): boolean {
  if (variant !== 'current-core') return true
  return (
    metrics.gateClassificationAccuracy >= 0.9 &&
    metrics.gateRiskAccuracy >= 0.75 &&
    metrics.criticalFalsePositives === 0 &&
    metrics.articlePassRate >= 0.8 &&
    metrics.errors === 0
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function mapLimit<Input, Output>(
  items: readonly Input[],
  concurrency: number,
  task: (item: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const output: Output[] = new Array(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      const item = items[index]
      if (item !== undefined) output[index] = await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return output
}

function editorialConfig(variant: PromptVariant): EditorialConfig {
  return {
    profile: editorialProfiles.general,
    instructions,
    gatePrompt: variant.gatePrompt,
    articlePrompt: variant.articlePrompt,
    languages: ['en'],
    publishThreshold: 0.75,
    deduplicationContextSize: 50,
  }
}

async function evaluateVariant(variant: PromptVariant, client: AiClient, concurrency: number): Promise<VariantResult> {
  const editorial = createEditorial(editorialConfig(variant), client)
  const gates = await mapLimit(gateCases, concurrency, async (evalCase): Promise<GateCaseResult> => {
    const started = performance.now()
    try {
      const decision = await editorial.evaluate(evalCase.candidate, evalCase.recentPublications ?? [])
      return {
        id: evalCase.id,
        category: evalCase.category,
        expectedPublish: evalCase.expectedPublish,
        expectedRisks: evalCase.expectedRisks,
        decision,
        ...scoreGateCase(evalCase, decision),
        durationMs: Math.round(performance.now() - started),
      }
    } catch (error) {
      return {
        id: evalCase.id,
        category: evalCase.category,
        expectedPublish: evalCase.expectedPublish,
        expectedRisks: evalCase.expectedRisks,
        classificationPassed: false,
        riskPassed: evalCase.expectedRisks ? false : undefined,
        criticalFalsePositive: false,
        error: errorMessage(error),
        durationMs: Math.round(performance.now() - started),
      }
    }
  })

  const articles = await mapLimit(articleCases, concurrency, async (evalCase): Promise<ArticleCaseResult> => {
    const started = performance.now()
    try {
      const approvedDecision: GateDecision = {
        publish: true,
        score: 0.95,
        reason: 'Approved eval fixture with source-bounded facts.',
        topics: ['technology'],
        risks: [],
        claims: [
          {
            id: 'claim-1',
            text: evalCase.candidate.content,
            sourceUrls: [evalCase.candidate.canonicalUrl],
          },
        ],
        uncertainties: [],
        sourceUrls: [evalCase.candidate.canonicalUrl],
      }
      const generated = await editorial.generate(evalCase.candidate, approvedDecision)
      const article = generated[0]
      if (!article) throw new Error('AI response did not contain an article')
      return {
        id: evalCase.id,
        article,
        ...scoreArticleCase(evalCase, article),
        durationMs: Math.round(performance.now() - started),
      }
    } catch (error) {
      return {
        id: evalCase.id,
        passed: false,
        failures: ['request-error'],
        error: errorMessage(error),
        durationMs: Math.round(performance.now() - started),
      }
    }
  })

  const riskResults = gates.filter(({ riskPassed }) => riskPassed !== undefined)
  const metrics: PromptEvalMetrics = {
    gateClassificationAccuracy: gates.filter(({ classificationPassed }) => classificationPassed).length / gates.length,
    gateRiskAccuracy:
      riskResults.length === 0 ? 1 : riskResults.filter(({ riskPassed }) => riskPassed).length / riskResults.length,
    criticalFalsePositives: gates.filter(({ criticalFalsePositive }) => criticalFalsePositive).length,
    articlePassRate: articles.filter(({ passed }) => passed).length / articles.length,
    errors: [...gates, ...articles].filter(({ error }) => error !== undefined).length,
  }
  return { id: variant.id, metrics, passed: variantPasses(metrics, variant.id), gates, articles }
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function printSummary(report: PromptEvalReport): void {
  console.log(`Prompt eval: ${report.provider}/${report.model} dataset=${report.datasetHash.slice(0, 12)}`)
  console.log('variant       gate       risk-tags  critical-fp  articles   errors  required')
  for (const result of report.variants) {
    const required = result.id === report.requiredVariant ? (result.passed ? 'PASS' : 'FAIL') : 'baseline'
    console.log(
      `${result.id.padEnd(13)} ${percentage(result.metrics.gateClassificationAccuracy).padEnd(10)} ${percentage(result.metrics.gateRiskAccuracy).padEnd(10)} ${String(result.metrics.criticalFalsePositives).padEnd(12)} ${percentage(result.metrics.articlePassRate).padEnd(10)} ${String(result.metrics.errors).padEnd(7)} ${required}`,
    )
  }
}

function optionValue(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv
    .slice(2)
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length)
}

function positiveInteger(value: string | undefined, fallback: number, name: string, maximum = 20): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new Error(`${name} must be between 1 and ${maximum}`)
  return parsed
}

function selectedVariants(): readonly PromptVariant[] {
  if (process.argv.includes('--compare')) return promptVariants
  const requested = optionValue('variant') ?? 'current-core'
  const selected = promptVariants.find(({ id }) => id === requested)
  if (!selected) throw new Error(`Unknown prompt variant: ${requested}`)
  return [selected]
}

function aiConfig(): AiConfig {
  const apiKey = process.env.AI_API_KEY?.trim() || process.env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) throw new Error('AI_API_KEY or DEEPSEEK_API_KEY is required for prompt eval')
  const model = process.env.AI_MODEL?.trim() || 'deepseek-v4-flash'
  return {
    provider: process.env.AI_PROVIDER?.trim() || 'deepseek',
    apiKey,
    baseUrl: (process.env.AI_BASE_URL?.trim() || 'https://api.deepseek.com/v1').replace(/\/$/, ''),
    model,
    allowedModels: [model],
    responseFormat: 'json_object',
    timeoutMs: positiveInteger(process.env.AI_TIMEOUT_SECONDS, 120, 'AI_TIMEOUT_SECONDS', 600) * 1_000,
    concurrency: positiveInteger(process.env.AI_CONCURRENCY, 4, 'AI_CONCURRENCY', 20),
  }
}

async function main(): Promise<void> {
  const config = aiConfig()
  const concurrency = positiveInteger(
    optionValue('concurrency') ?? process.env.PROMPT_EVAL_CONCURRENCY,
    4,
    'concurrency',
  )
  const startedAt = new Date().toISOString()
  const variants = await mapLimit(selectedVariants(), 1, (variant) =>
    evaluateVariant(variant, createOpenAiClient(config), concurrency),
  )
  const requiredVariant: PromptVariant['id'] = 'current-core'
  const requiredResult = variants.find(({ id }) => id === requiredVariant)
  const report: PromptEvalReport = {
    schemaVersion: 1,
    datasetHash: createHash('sha256').update(JSON.stringify({ gateCases, articleCases })).digest('hex'),
    provider: config.provider,
    model: config.model,
    startedAt,
    finishedAt: new Date().toISOString(),
    requiredVariant,
    passed: requiredResult?.passed ?? true,
    variants,
  }
  printSummary(report)
  const outputPath = optionValue('output')
  if (outputPath) {
    const resolved = path.resolve(outputPath)
    await mkdir(path.dirname(resolved), { recursive: true })
    await writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(`Report: ${resolved}`)
  }
  if (!report.passed) process.exitCode = 1
}

if (import.meta.main) await main()
