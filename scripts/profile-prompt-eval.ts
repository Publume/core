import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createEditorial } from '../src/adapters/editorial'
import { type AiClient, createOpenAiClient } from '../src/adapters/openai'
import { DEFAULT_ARTICLE_PROMPT, DEFAULT_GATE_PROMPT } from '../src/config/load'
import type { AiConfig, EditorialConfig } from '../src/config/model'
import {
  type EditorialProfile,
  type EditorialProfileId,
  editorialProfileIds,
  editorialProfiles,
} from '../src/config/profiles'
import {
  type Candidate,
  candidateReports,
  type EvidenceClaim,
  type GateDecision,
  type GeneratedArticle,
} from '../src/domain/content'

type LegacyProfileId = 'news' | 'briefing' | 'analysis'
type EvalLanguage = 'en' | 'zh-CN'

type GateEvalCase = {
  readonly id: string
  readonly profileId: EditorialProfileId
  readonly candidate: Candidate
  readonly expectedPublish: boolean
  readonly critical?: boolean
}

type RequiredFact = {
  readonly id: string
  readonly alternatives: readonly string[]
  readonly allOf?: readonly (readonly string[])[]
}

type ArticleEvalCase = {
  readonly id: string
  readonly profileId: EditorialProfileId
  readonly candidate: Candidate
  readonly claims: readonly EvidenceClaim[]
  readonly requiredFacts: readonly RequiredFact[]
  readonly forbiddenClaims: readonly RequiredFact[]
}

type GateResult = {
  readonly id: string
  readonly profileId: EditorialProfileId
  readonly expectedPublish: boolean
  readonly passed: boolean
  readonly criticalFalsePositive: boolean
  readonly actualPublish?: boolean
  readonly score?: number
  readonly reason?: string
  readonly responses: readonly string[]
  readonly error?: string
  readonly durationMs: number
}

type ArticleResult = {
  readonly id: string
  readonly profileId: EditorialProfileId
  readonly factMatches: number
  readonly factTotal: number
  readonly forbiddenClaims: number
  readonly missingFactIds: readonly string[]
  readonly stylePassed: boolean
  readonly structurePassed: boolean
  readonly summaryDistinct: boolean
  readonly passed: boolean
  readonly output?: GeneratedArticle
  readonly responses: readonly string[]
  readonly error?: string
  readonly durationMs: number
}

export type ProfilePromptMetrics = {
  readonly gateAccuracy: number
  readonly criticalFalsePositives: number
  readonly articleFactRecall: number
  readonly articleStyleRate: number
  readonly articleStructureRate: number
  readonly summaryDistinctRate: number
  readonly articlePassRate: number
  readonly forbiddenClaims: number
  readonly errors: number
}

export type ProfilePromptEvaluation = {
  readonly metrics: ProfilePromptMetrics
  readonly profiles: Readonly<Partial<Record<EditorialProfileId, ProfilePromptMetrics>>>
}

type SuiteResult = ProfilePromptEvaluation & {
  readonly gates: readonly GateResult[]
  readonly articles: readonly ArticleResult[]
}

export const profilePromptThresholds = {
  minimumArticleFactRecall: 0.75,
  gateAccuracy: 0.9,
  articleFactRecall: 0.9,
  articleStyleRate: 0.85,
  articleStructureRate: 1,
  summaryDistinctRate: 0.85,
  articlePassRate: 0.8,
  minimumProfileGateAccuracy: 0.5,
  minimumProfileFactRecall: 0.7,
  maximumRegression: 0.12,
  minimumStructureImprovement: 0.5,
} as const

type ProfilePromptReport = {
  readonly schemaVersion: 3
  readonly datasetHash: string
  readonly beforeProfileHash: string
  readonly currentProfileHash: string
  readonly provider: string
  readonly model: string
  readonly language: EvalLanguage
  readonly thresholds: typeof profilePromptThresholds
  readonly startedAt: string
  readonly finishedAt: string
  readonly passed: boolean
  readonly current: SuiteResult
  readonly comparison: {
    readonly before: SuiteResult
    readonly after: SuiteResult
    readonly delta: Pick<
      ProfilePromptMetrics,
      | 'gateAccuracy'
      | 'articleFactRecall'
      | 'articleStyleRate'
      | 'articleStructureRate'
      | 'summaryDistinctRate'
      | 'articlePassRate'
    >
  }
}

const instructions: Readonly<Record<EvalLanguage, string>> = {
  en: 'Publish source-linked information for a mixed professional audience. Prefer material changes, concrete evidence, explicit uncertainty, and concise explanation.',
  'zh-CN':
    '\u{4E3A}\u{4E13}\u{4E1A}\u{8BFB}\u{8005}\u{53D1}\u{5E03}\u{9644}\u{5E26}\u{6765}\u{6E90}\u{7684}\u{4FE1}\u{606F}\u{3002}\u{4F18}\u{5148}\u{4FDD}\u{7559}\u{5B9E}\u{8D28}\u{53D8}\u{5316}\u{3001}\u{5177}\u{4F53}\u{8BC1}\u{636E}\u{3001}\u{660E}\u{786E}\u{7684}\u{4E0D}\u{786E}\u{5B9A}\u{6027}\u{548C}\u{7B80}\u{6D01}\u{89E3}\u{91CA}\u{3002}\u{4F7F}\u{7528}\u{81EA}\u{7136}\u{3001}\u{4E13}\u{4E1A}\u{7684}\u{7B80}\u{4F53}\u{4E2D}\u{6587}\u{FF0C}\u{907F}\u{514D}\u{9010}\u{5B57}\u{7FFB}\u{8BD1}\u{8154}\u{3002}',
}

function candidate(id: string, title: string, content: string, canonicalUrl: string): Candidate {
  return {
    sourceId: new URL(canonicalUrl).hostname,
    externalId: id,
    canonicalUrl,
    title,
    content,
    contentOrigin: 'article-page',
    publishedAt: '2026-08-08T08:00:00.000Z',
  }
}

function mergedCandidate(id: string, title: string, reports: readonly Candidate[]): Candidate {
  const primary = reports[0]
  if (!primary) throw new Error('Merged eval candidate needs at least one report')
  return { ...primary, externalId: id, title, reports }
}

export const profileGateCases: readonly GateEvalCase[] = [
  {
    id: 'general-authoritative-change',
    profileId: 'general',
    candidate: candidate(
      'general-authoritative-change',
      'City closes East River bridge to freight traffic for six weeks',
      'The transport department will close the bridge to vehicles over 3.5 tonnes from August 10 through September 21 for bearing replacement. Passenger cars and buses may continue to use one lane.',
      'https://transport.city.gov/notices/east-river-bearing-work',
    ),
    expectedPublish: true,
  },
  {
    id: 'general-unsupported-opinion',
    profileId: 'general',
    candidate: candidate(
      'general-unsupported-opinion',
      'Remote work has permanently ended',
      'The author predicts every technology company will end remote work this year but supplies no policy data, company list, survey, or attributable evidence.',
      'https://workplacecolumn.com/remote-work-ended',
    ),
    expectedPublish: false,
    critical: true,
  },
  {
    id: 'briefing-actionable-change',
    profileId: 'briefing',
    candidate: candidate(
      'briefing-actionable-change',
      'Transit API raises availability target on September 1',
      'MetroCloud will raise the Transit API monthly availability target from 99.9% to 99.95% on September 1 for Pro and Enterprise plans. The service-credit formula is unchanged.',
      'https://metrocloud.com/changelog/transit-api-slo',
    ),
    expectedPublish: true,
  },
  {
    id: 'briefing-minor-noise',
    profileId: 'briefing',
    candidate: candidate(
      'briefing-minor-noise',
      'DeskNote 2.4.1 corrects two menu translations',
      'The patch changes two translations and includes no behavior, compatibility, security, pricing, or availability change.',
      'https://desknote.app/releases/2.4.1',
    ),
    expectedPublish: false,
  },
  {
    id: 'analysis-independent-evidence',
    profileId: 'analysis',
    candidate: mergedCandidate('analysis-independent-evidence', 'Sparse inference lowers measured energy use', [
      candidate(
        'analysis-paper',
        'Controlled study measures lower sparse-model inference energy',
        'A peer-reviewed paper reports 27% lower inference energy than its dense baseline under the authors controlled benchmark. It says production workloads were not tested.',
        'https://dl.acm.org/doi/10.1145/3990001',
      ),
      candidate(
        'analysis-artifact',
        'SparseNet-12 benchmark artifact documents test conditions',
        'The public artifact records the accelerator, batch size, dense baseline, and three repeated runs. It does not contain production workload results.',
        'https://github.com/example-research/sparsenet-12-artifact',
      ),
    ]),
    expectedPublish: true,
  },
  {
    id: 'analysis-thin-announcement',
    profileId: 'analysis',
    candidate: candidate(
      'analysis-thin-announcement',
      'Acme previews a future collaboration experience',
      'Acme says an upcoming experience will transform teamwork but provides no features, date, measurements, customers, or supporting source.',
      'https://acme.example.org/news/future-collaboration',
    ),
    expectedPublish: false,
  },
  {
    id: 'explainer-transferable-depth',
    profileId: 'explainer',
    candidate: candidate(
      'explainer-transferable-depth',
      'How we removed tail-latency spikes from a multi-tenant cache',
      'The engineering team traces p99 spikes to lock convoying during eviction. It compares three designs under the same workload, explains why sharding alone failed, and shows that an admission queue reduced p99 latency from 420 ms to 170 ms. Memory use rose 8%, and the authors explain when the tradeoff is unacceptable.',
      'https://engineering.example.net/cache-tail-latency',
    ),
    expectedPublish: true,
  },
  {
    id: 'explainer-release-note',
    profileId: 'explainer',
    candidate: candidate(
      'explainer-release-note',
      'DeskNote 3.0 is available',
      'DeskNote 3.0 adds a dark theme, two keyboard shortcuts, and a redesigned settings page. Download links are available now.',
      'https://desknote.app/blog/version-3',
    ),
    expectedPublish: false,
  },
  {
    id: 'research-review-controlled-study',
    profileId: 'research-review',
    candidate: candidate(
      'research-review-controlled-study',
      'Classroom filter study measures lower particulate exposure',
      'A peer-reviewed randomized study of 120 classrooms reports 18% lower average PM2.5 exposure than control classrooms over 12 weeks. The authors did not measure respiratory outcomes and say the result should not be interpreted as proof of health benefit.',
      'https://journal.example.org/articles/classroom-filter-trial',
    ),
    expectedPublish: true,
  },
  {
    id: 'research-review-press-release-cure',
    profileId: 'research-review',
    candidate: candidate(
      'research-review-press-release-cure',
      'Startup says its lamp cures seasonal depression',
      'A company press release calls its prototype lamp a cure. It supplies no study, sample, control group, measurement, effect size, review status, or adverse-event evidence.',
      'https://brightfuture.example.com/press/lamp-cure',
    ),
    expectedPublish: false,
    critical: true,
  },
  {
    id: 'risk-advisory-confirmed-scope',
    profileId: 'risk-advisory',
    candidate: candidate(
      'risk-advisory-confirmed-scope',
      'AcmeGateway flaw is exploited against internet-exposed admin panels',
      'The vendor and national cyber agency say CVE-2026-4410 is exploited in AcmeGateway 4.2 through 4.5 when the admin panel is internet-exposed. Version 4.5.1 fixes the flaw. The advisory tells operators to update and restrict admin access.',
      'https://security.example.gov/advisories/cve-2026-4410',
    ),
    expectedPublish: true,
  },
  {
    id: 'risk-advisory-anonymous-alarm',
    profileId: 'risk-advisory',
    candidate: candidate(
      'risk-advisory-anonymous-alarm',
      'Every smart lock may already be compromised',
      'An anonymous account says every brand of smart lock is compromised but names no product, version, test, incident, indicator, affected condition, or source.',
      'https://alarmwire.example.net/all-smart-locks',
    ),
    expectedPublish: false,
    critical: true,
  },
  {
    id: 'policy-tracker-final-rule',
    profileId: 'policy-tracker',
    candidate: candidate(
      'policy-tracker-final-rule',
      'Coastal Data Agency publishes account portability rule',
      'The Coastal Data Agency published a final rule effective November 1. Providers with more than 100,000 active accounts must provide exports within 30 days of a verified request. Smaller providers are exempt.',
      'https://cda.example.gov/rules/account-portability-final',
    ),
    expectedPublish: true,
  },
  {
    id: 'policy-tracker-draft-as-law',
    profileId: 'policy-tracker',
    candidate: candidate(
      'policy-tracker-draft-as-law',
      'All platforms must verify every user next month',
      'A legislator released discussion text and invited comments. No bill has been introduced, voted on, enacted, published, or assigned an effective date, but the article says the requirement is already law.',
      'https://politicsdaily.example.net/platform-verification-law',
    ),
    expectedPublish: false,
    critical: true,
  },
  {
    id: 'market-intelligence-material-result',
    profileId: 'market-intelligence',
    candidate: candidate(
      'market-intelligence-material-result',
      'Harbor Bank profit falls as provisions rise',
      'Harbor Bank reported second-quarter net profit of $84 million, down from $126 million a year earlier, after credit-loss provisions rose to $61 million from $22 million. The figures are actual reported results.',
      'https://harborbank.example.com/investors/q2-2026-results',
    ),
    expectedPublish: true,
  },
  {
    id: 'market-intelligence-unexplained-move',
    profileId: 'market-intelligence',
    candidate: candidate(
      'market-intelligence-unexplained-move',
      'Microcap token jumps 35% and could triple',
      'The token rose 35% in thin trading. Anonymous social accounts predict it will triple, but the report gives no starting price, company event, disclosed model, named analyst, or supporting document.',
      'https://marketbuzz.example.net/microcap-token',
    ),
    expectedPublish: false,
    critical: true,
  },
  {
    id: 'product-update-material-release',
    profileId: 'product-update',
    candidate: candidate(
      'product-update-material-release',
      'NebulaDB 6.0 changes replication and adds online schema migration',
      'NebulaDB 6.0 is generally available. It changes the default replication protocol, adds online schema migration, documents the 5.x upgrade path, and warns that legacy clients need compatibility mode.',
      'https://github.com/nebula-labs/nebuladb/releases/tag/v6.0.0',
    ),
    expectedPublish: true,
  },
  {
    id: 'product-update-finance-only',
    profileId: 'product-update',
    candidate: candidate(
      'product-update-finance-only',
      'CloudWorks quarterly revenue rises 18%',
      'CloudWorks reported quarterly revenue of $840 million, up 18% from a year earlier, and raised its full-year revenue forecast. It announced no product, pricing, availability, compatibility, or platform change.',
      'https://cloudworks.example.com/investors/q2-2026',
    ),
    expectedPublish: false,
  },
]

function gateCandidate(id: string): Candidate {
  const evalCase = profileGateCases.find((candidateCase) => candidateCase.id === id)
  if (!evalCase) throw new Error(`Missing gate fixture: ${id}`)
  return evalCase.candidate
}

function claim(id: string, text: string, sourceUrl: string): EvidenceClaim {
  return { id, text, sourceUrls: [sourceUrl] }
}

export const profileArticleCases: readonly ArticleEvalCase[] = [
  {
    id: 'general-article',
    profileId: 'general',
    candidate: gateCandidate('general-authoritative-change'),
    claims: [
      claim(
        'claim-1',
        'The bridge closes to vehicles over 3.5 tonnes from August 10 through September 21 for bearing replacement; cars and buses retain one lane.',
        'https://transport.city.gov/notices/east-river-bearing-work',
      ),
    ],
    requiredFacts: [
      { id: 'weight', alternatives: ['3.5 tonnes', '3.5 tons', '3.5\u{5428}', '3.5 \u{5428}'] },
      { id: 'start-date', alternatives: ['august 10', 'aug. 10', '8\u{6708}10\u{65E5}', '8 \u{6708} 10 \u{65E5}'] },
      { id: 'end-date', alternatives: ['september 21', 'sept. 21', '9\u{6708}21\u{65E5}', '9 \u{6708} 21 \u{65E5}'] },
      {
        id: 'reason',
        alternatives: ['bearing replacement', '\u{66F4}\u{6362}\u{652F}\u{5EA7}', '\u{652F}\u{5EA7}\u{66F4}\u{6362}'],
      },
    ],
    forbiddenClaims: [
      {
        id: 'full-closure',
        alternatives: [
          'closed to all traffic',
          'cars cannot cross',
          '\u{6240}\u{6709}\u{8F66}\u{8F86}\u{7981}\u{6B62}\u{901A}\u{884C}',
          '\u{5C0F}\u{6C7D}\u{8F66}\u{65E0}\u{6CD5}\u{901A}\u{884C}',
        ],
      },
    ],
  },
  {
    id: 'briefing-article',
    profileId: 'briefing',
    candidate: gateCandidate('briefing-actionable-change'),
    claims: [
      claim(
        'claim-1',
        'The Transit API monthly target rises from 99.9% to 99.95% on September 1 for Pro and Enterprise plans; the service-credit formula is unchanged.',
        'https://metrocloud.com/changelog/transit-api-slo',
      ),
    ],
    requiredFacts: [
      { id: 'old-target', alternatives: ['99.9%'] },
      { id: 'new-target', alternatives: ['99.95%'] },
      { id: 'plans', alternatives: ['pro and enterprise', 'pro \u{548C} enterprise', 'pro \u{4E0E} enterprise'] },
      {
        id: 'credits',
        alternatives: [
          'credit formula is unchanged',
          'service-credit formula is unchanged',
          'service-credit formula unchanged',
          'service-credit formula will remain unchanged',
          'service-credit formula remains unchanged',
          'unchanged: service-credit formula',
          '\u{670D}\u{52A1}\u{989D}\u{5EA6}\u{8BA1}\u{7B97}\u{516C}\u{5F0F}\u{4FDD}\u{6301}\u{4E0D}\u{53D8}',
          '\u{670D}\u{52A1}\u{989D}\u{5EA6}\u{8BA1}\u{7B97}\u{516C}\u{5F0F}\u{672A}\u{4F5C}\u{8C03}\u{6574}',
          '\u{670D}\u{52A1}\u{8865}\u{507F}\u{8BA1}\u{7B97}\u{516C}\u{5F0F}\u{4FDD}\u{6301}\u{4E0D}\u{53D8}',
          '\u{670D}\u{52A1}\u{79EF}\u{5206}\u{516C}\u{5F0F}\u{4FDD}\u{6301}\u{4E0D}\u{53D8}',
        ],
        allOf: [
          ['service', '\u{670D}\u{52A1}'],
          ['formula', '\u{516C}\u{5F0F}'],
          [
            'unchanged',
            '\u{4E0D}\u{53D8}',
            '\u{672A}\u{4F5C}\u{8C03}\u{6574}',
            '\u{672A}\u{53D1}\u{751F}\u{53D8}\u{5316}',
          ],
        ],
      },
    ],
    forbiddenClaims: [
      {
        id: 'higher-credit',
        alternatives: [
          'service credits will increase',
          '\u{670D}\u{52A1}\u{989D}\u{5EA6}\u{5C06}\u{589E}\u{52A0}',
          '\u{670D}\u{52A1}\u{8865}\u{507F}\u{5C06}\u{589E}\u{52A0}',
        ],
      },
    ],
  },
  {
    id: 'analysis-article',
    profileId: 'analysis',
    candidate: gateCandidate('analysis-independent-evidence'),
    claims: [
      claim(
        'claim-1',
        'The paper reports 27% lower inference energy than a dense baseline in a controlled benchmark and says production workloads were not tested.',
        'https://dl.acm.org/doi/10.1145/3990001',
      ),
      claim(
        'claim-2',
        'The artifact identifies the accelerator, batch size, dense baseline, and three repeated runs.',
        'https://github.com/example-research/sparsenet-12-artifact',
      ),
    ],
    requiredFacts: [
      { id: 'energy', alternatives: ['27%'] },
      {
        id: 'baseline',
        alternatives: ['dense baseline', '\u{7A20}\u{5BC6}\u{57FA}\u{7EBF}'],
        allOf: [
          ['dense', '\u{7A20}\u{5BC6}', '\u{5BC6}\u{96C6}'],
          ['baseline', '\u{57FA}\u{7EBF}'],
        ],
      },
      {
        id: 'limitation',
        alternatives: [
          'production workloads were not tested',
          'not tested on production workloads',
          '\u{672A}\u{6D4B}\u{8BD5}\u{751F}\u{4EA7}\u{8D1F}\u{8F7D}',
          '\u{751F}\u{4EA7}\u{8D1F}\u{8F7D}\u{672A}\u{6D4B}\u{8BD5}',
          '\u{751F}\u{4EA7}\u{8D1F}\u{8F7D}\u{672A}\u{88AB}\u{6D4B}\u{8BD5}',
        ],
        allOf: [
          ['production', '\u{751F}\u{4EA7}'],
          ['workload', '\u{8D1F}\u{8F7D}', '\u{5DE5}\u{4F5C}\u{8D1F}\u{8F7D}'],
          [
            'not tested',
            '\u{672A}\u{6D4B}\u{8BD5}',
            '\u{672A}\u{88AB}\u{6D4B}\u{8BD5}',
            '\u{672A}\u{7EB3}\u{5165}\u{6D4B}\u{8BD5}',
          ],
        ],
      },
      {
        id: 'runs',
        alternatives: [
          'three repeated runs',
          '3 repeated runs',
          '\u{4E09}\u{6B21}\u{91CD}\u{590D}\u{8FD0}\u{884C}',
          '3\u{6B21}\u{91CD}\u{590D}\u{8FD0}\u{884C}',
        ],
      },
    ],
    forbiddenClaims: [
      {
        id: 'production-proof',
        alternatives: [
          'proven in production',
          'reduces production energy by 27%',
          '\u{5DF2}\u{5728}\u{751F}\u{4EA7}\u{73AF}\u{5883}\u{8BC1}\u{5B9E}',
          '\u{751F}\u{4EA7}\u{73AF}\u{5883}\u{80FD}\u{8017}\u{964D}\u{4F4E}27%',
          '\u{5DF2}\u{88AB}\u{72EC}\u{7ACB}\u{590D}\u{73B0}',
        ],
      },
    ],
  },
  {
    id: 'explainer-article',
    profileId: 'explainer',
    candidate: gateCandidate('explainer-transferable-depth'),
    claims: [
      claim(
        'claim-1',
        'The authors traced p99 spikes to lock convoying, found sharding alone insufficient, and used an admission queue to reduce p99 from 420 ms to 170 ms while increasing memory use by 8%.',
        'https://engineering.example.net/cache-tail-latency',
      ),
    ],
    requiredFacts: [
      {
        id: 'problem',
        alternatives: ['lock convoying', '\u{9501}\u{7ADE}\u{4E89}', '\u{9501}\u{961F}\u{5217}\u{62E5}\u{585E}'],
      },
      {
        id: 'failed-approach',
        alternatives: ['sharding alone', '\u{4EC5}\u{9760}\u{5206}\u{7247}', '\u{5355}\u{9760}\u{5206}\u{7247}'],
      },
      { id: 'latency-before', alternatives: ['420 ms'] },
      { id: 'latency-after', alternatives: ['170 ms'] },
      { id: 'tradeoff', alternatives: ['8%'] },
    ],
    forbiddenClaims: [
      {
        id: 'universal',
        alternatives: [
          'works for every workload',
          'eliminates all latency',
          '\u{9002}\u{7528}\u{4E8E}\u{6240}\u{6709}\u{5DE5}\u{4F5C}\u{8D1F}\u{8F7D}',
          '\u{6D88}\u{9664}\u{6240}\u{6709}\u{5EF6}\u{8FDF}',
        ],
      },
      {
        id: 'invented-mechanism',
        alternatives: [
          'paces requests entering the cache',
          '\u{7BA1}\u{7406}\u{8BF7}\u{6C42}\u{8FDB}\u{5165}\u{7F13}\u{5B58}\u{7684}\u{8282}\u{594F}',
        ],
      },
    ],
  },
  {
    id: 'research-review-article',
    profileId: 'research-review',
    candidate: gateCandidate('research-review-controlled-study'),
    claims: [
      claim(
        'claim-1',
        'A peer-reviewed randomized study of 120 classrooms reports 18% lower average PM2.5 exposure than controls over 12 weeks and did not measure respiratory outcomes.',
        'https://journal.example.org/articles/classroom-filter-trial',
      ),
    ],
    requiredFacts: [
      {
        id: 'design',
        alternatives: ['randomized', '\u{968F}\u{673A}\u{7814}\u{7A76}', '\u{968F}\u{673A}\u{5BF9}\u{7167}'],
      },
      { id: 'sample', alternatives: ['120 classrooms', '120\u{95F4}\u{6559}\u{5BA4}', '120 \u{95F4}\u{6559}\u{5BA4}'] },
      { id: 'effect', alternatives: ['18%'] },
      { id: 'duration', alternatives: ['12 weeks', '12\u{5468}', '12 \u{5468}'] },
      {
        id: 'limitation',
        alternatives: [
          'did not measure respiratory outcomes',
          'respiratory outcomes were not measured',
          '\u{672A}\u{6D4B}\u{91CF}\u{547C}\u{5438}\u{7ED3}\u{5C40}',
          '\u{6CA1}\u{6709}\u{6D4B}\u{91CF}\u{547C}\u{5438}\u{7ED3}\u{5C40}',
          '\u{672A}\u{6D4B}\u{91CF}\u{547C}\u{5438}\u{9053}\u{7ED3}\u{5C40}',
          '\u{672A}\u{6536}\u{96C6}\u{547C}\u{5438}\u{7CFB}\u{7EDF}\u{5065}\u{5EB7}\u{6570}\u{636E}',
        ],
        allOf: [
          ['respiratory', '\u{547C}\u{5438}'],
          ['outcome', '\u{7ED3}\u{5C40}', '\u{7ED3}\u{679C}', '\u{6570}\u{636E}'],
          ['not measured', '\u{672A}\u{6D4B}\u{91CF}', '\u{6CA1}\u{6709}\u{6D4B}\u{91CF}', '\u{672A}\u{6536}\u{96C6}'],
        ],
      },
    ],
    forbiddenClaims: [
      {
        id: 'health-benefit',
        alternatives: [
          'proves a health benefit',
          'prevents respiratory disease',
          '\u{8BC1}\u{660E}\u{5065}\u{5EB7}\u{83B7}\u{76CA}',
          '\u{9884}\u{9632}\u{547C}\u{5438}\u{7CFB}\u{7EDF}\u{75BE}\u{75C5}',
        ],
      },
      {
        id: 'invented-outcomes',
        alternatives: ['cough or asthma attacks', '\u{54B3}\u{55FD}', '\u{54EE}\u{5598}\u{53D1}\u{4F5C}'],
      },
    ],
  },
  {
    id: 'risk-advisory-article',
    profileId: 'risk-advisory',
    candidate: gateCandidate('risk-advisory-confirmed-scope'),
    claims: [
      claim(
        'claim-1',
        'CVE-2026-4410 is exploited against internet-exposed admin panels in AcmeGateway 4.2 through 4.5; version 4.5.1 fixes it, and the advisory says to update and restrict admin access.',
        'https://security.example.gov/advisories/cve-2026-4410',
      ),
    ],
    requiredFacts: [
      { id: 'affected', alternatives: ['4.2 through 4.5', '4.2 to 4.5', '4.2 \u{81F3} 4.5', '4.2 \u{5230} 4.5'] },
      { id: 'fixed', alternatives: ['4.5.1'] },
      {
        id: 'condition',
        alternatives: [
          'internet-exposed admin',
          'admin panels reachable from the internet',
          'admin panels exposed to the internet',
          '\u{66B4}\u{9732}\u{5728}\u{4E92}\u{8054}\u{7F51}\u{4E0A}\u{7684}\u{7BA1}\u{7406}\u{540E}\u{53F0}',
          '\u{66B4}\u{9732}\u{4E8E}\u{4E92}\u{8054}\u{7F51}\u{7684}\u{7BA1}\u{7406}\u{540E}\u{53F0}',
          '\u{7BA1}\u{7406}\u{5458}\u{9762}\u{677F}\u{66B4}\u{9732}\u{4E8E}\u{4E92}\u{8054}\u{7F51}',
        ],
        allOf: [
          [
            'admin panel',
            'admin-panel',
            '\u{7BA1}\u{7406}\u{540E}\u{53F0}',
            '\u{7BA1}\u{7406}\u{5458}\u{9762}\u{677F}',
            '\u{7BA1}\u{7406}\u{9762}\u{677F}',
          ],
          ['internet', '\u{4E92}\u{8054}\u{7F51}'],
          ['exposed', 'reachable', '\u{66B4}\u{9732}'],
        ],
      },
      {
        id: 'status',
        alternatives: [
          'exploited',
          '\u{6B63}\u{5728}\u{88AB}\u{5229}\u{7528}',
          '\u{6B63}\u{88AB}\u{5229}\u{7528}',
          '\u{906D}\u{5229}\u{7528}',
        ],
      },
      {
        id: 'mitigation',
        alternatives: [
          'restrict admin access',
          'restricting admin access',
          'restrict admin-panel access',
          'limit admin panel access',
          'limiting admin panel access',
          '\u{9650}\u{5236}\u{7BA1}\u{7406}\u{540E}\u{53F0}\u{8BBF}\u{95EE}',
          '\u{9650}\u{5236}\u{540E}\u{53F0}\u{8BBF}\u{95EE}',
          '\u{9650}\u{5236}\u{7BA1}\u{7406}\u{5458}\u{9762}\u{677F}\u{7684}\u{8BBF}\u{95EE}',
        ],
        allOf: [
          ['restrict', 'limit', '\u{9650}\u{5236}'],
          [
            'admin panel',
            'admin-panel',
            '\u{7BA1}\u{7406}\u{540E}\u{53F0}',
            '\u{7BA1}\u{7406}\u{5458}\u{9762}\u{677F}',
            '\u{7BA1}\u{7406}\u{9762}\u{677F}',
          ],
          ['access', '\u{8BBF}\u{95EE}'],
        ],
      },
    ],
    forbiddenClaims: [
      {
        id: 'universal',
        alternatives: [
          'all versions are compromised',
          'every acmegateway is compromised',
          '\u{6240}\u{6709}\u{7248}\u{672C}\u{5747}\u{5DF2}\u{5931}\u{9677}',
        ],
      },
    ],
  },
  {
    id: 'policy-tracker-article',
    profileId: 'policy-tracker',
    candidate: gateCandidate('policy-tracker-final-rule'),
    claims: [
      claim(
        'claim-1',
        'The Coastal Data Agency final rule takes effect November 1 and requires providers with more than 100,000 active accounts to provide exports within 30 days; smaller providers are exempt.',
        'https://cda.example.gov/rules/account-portability-final',
      ),
    ],
    requiredFacts: [
      { id: 'status', alternatives: ['final rule', '\u{6700}\u{7EC8}\u{89C4}\u{5219}'] },
      { id: 'effective', alternatives: ['november 1', '11\u{6708}1\u{65E5}', '11 \u{6708} 1 \u{65E5}'] },
      {
        id: 'threshold',
        alternatives: [
          '100,000 active accounts',
          '10\u{4E07}\u{6D3B}\u{8DC3}\u{8D26}\u{6237}',
          '10 \u{4E07}\u{6D3B}\u{8DC3}\u{8D26}\u{6237}',
        ],
        allOf: [
          ['100,000', '10\u{4E07}', '10\u{4E07}\u{4E2A}'],
          ['active account', '\u{6D3B}\u{8DC3}\u{8D26}\u{6237}'],
        ],
      },
      { id: 'deadline', alternatives: ['within 30 days', '30\u{5929}\u{5185}', '30 \u{5929}\u{5185}'] },
      {
        id: 'exception',
        alternatives: [
          'smaller providers are exempt',
          'smaller providers remain exempt',
          'exempting smaller providers',
          'exempts smaller providers',
          'providers with 100,000 or fewer active accounts are exempt',
          'providers at or below that threshold are outside',
          '\u{8F83}\u{5C0F}\u{4F9B}\u{5E94}\u{5546}\u{4E0D}\u{5728}\u{6B64}\u{4E49}\u{52A1}\u{8303}\u{56F4}\u{5185}',
          '\u{672A}\u{8D85}\u{8FC7}\u{8BE5}\u{95E8}\u{69DB}\u{7684}\u{8F83}\u{5C0F}\u{4F9B}\u{5E94}\u{5546}\u{4E0D}\u{5728}\u{4E49}\u{52A1}\u{8303}\u{56F4}\u{5185}',
          '10\u{4E07}\u{6216}\u{4EE5}\u{4E0B}\u{7684}\u{4F9B}\u{5E94}\u{5546}\u{8C41}\u{514D}',
          '\u{6D3B}\u{8DC3}\u{8D26}\u{6237}\u{6570}\u{672A}\u{8D85}\u{8FC7}10\u{4E07}\u{7684}\u{670D}\u{52A1}\u{63D0}\u{4F9B}\u{5546}\u{4E0D}\u{627F}\u{62C5}\u{8BE5}\u{4E49}\u{52A1}',
        ],
        allOf: [
          [
            'smaller',
            '100,000 or fewer',
            'at or below',
            '\u{672A}\u{8D85}\u{8FC7}',
            '10\u{4E07}\u{6216}\u{4EE5}\u{4E0B}',
          ],
          ['provider', '\u{4F9B}\u{5E94}\u{5546}', '\u{63D0}\u{4F9B}\u{5546}'],
          ['exempt', 'outside', '\u{8C41}\u{514D}', '\u{4E0D}\u{627F}\u{62C5}', '\u{4E0D}\u{5728}\u{4E49}\u{52A1}'],
        ],
      },
    ],
    forbiddenClaims: [
      {
        id: 'already-effective',
        alternatives: [
          'already in effect',
          'currently required',
          '\u{5DF2}\u{7ECF}\u{751F}\u{6548}',
          '\u{5F53}\u{524D}\u{5DF2}\u{7ECF}\u{8981}\u{6C42}',
        ],
      },
    ],
  },
  {
    id: 'market-intelligence-article',
    profileId: 'market-intelligence',
    candidate: gateCandidate('market-intelligence-material-result'),
    claims: [
      claim(
        'claim-1',
        'Harbor Bank reported actual second-quarter net profit of $84 million versus $126 million a year earlier as credit-loss provisions rose to $61 million from $22 million.',
        'https://harborbank.example.com/investors/q2-2026-results',
      ),
    ],
    requiredFacts: [
      { id: 'profit', alternatives: ['$84 million', '8400\u{4E07}\u{7F8E}\u{5143}', '8400 \u{4E07}\u{7F8E}\u{5143}'] },
      {
        id: 'profit-baseline',
        alternatives: ['$126 million', '1.26\u{4EBF}\u{7F8E}\u{5143}', '1.26 \u{4EBF}\u{7F8E}\u{5143}'],
      },
      {
        id: 'provisions',
        alternatives: ['$61 million', '6100\u{4E07}\u{7F8E}\u{5143}', '6100 \u{4E07}\u{7F8E}\u{5143}'],
      },
      {
        id: 'provisions-baseline',
        alternatives: ['$22 million', '2200\u{4E07}\u{7F8E}\u{5143}', '2200 \u{4E07}\u{7F8E}\u{5143}'],
      },
      {
        id: 'period',
        alternatives: [
          'second-quarter',
          'second quarter',
          '\u{7B2C}\u{4E8C}\u{5B63}\u{5EA6}',
          '\u{4E8C}\u{5B63}\u{5EA6}',
        ],
      },
    ],
    forbiddenClaims: [
      {
        id: 'advice',
        alternatives: [
          'buy the stock',
          'sell the stock',
          'investment opportunity',
          '\u{4E70}\u{5165}\u{80A1}\u{7968}',
          '\u{5356}\u{51FA}\u{80A1}\u{7968}',
        ],
      },
      {
        id: 'forecast',
        alternatives: [
          'the share price will',
          'guaranteed to fall',
          '\u{80A1}\u{4EF7}\u{5C06}\u{4F1A}',
          '\u{4FDD}\u{8BC1}\u{4E0B}\u{8DCC}',
        ],
      },
      {
        id: 'unsupported-cause',
        alternatives: [
          '\u{62E8}\u{5907}\u{4E0A}\u{5347}\u{5BFC}\u{81F4}\u{5229}\u{6DA6}\u{4E0B}\u{964D}',
          'provisions caused the profit decline',
        ],
      },
    ],
  },
  {
    id: 'product-update-article',
    profileId: 'product-update',
    candidate: gateCandidate('product-update-material-release'),
    claims: [
      claim(
        'claim-1',
        'NebulaDB 6.0 is generally available, changes the default replication protocol, adds online schema migration, documents the 5.x upgrade path, and requires compatibility mode for legacy clients.',
        'https://github.com/nebula-labs/nebuladb/releases/tag/v6.0.0',
      ),
    ],
    requiredFacts: [
      { id: 'version', alternatives: ['nebuladb 6.0'] },
      {
        id: 'status',
        alternatives: ['generally available', '\u{6B63}\u{5F0F}\u{53D1}\u{5E03}', '\u{4E00}\u{822C}\u{53EF}\u{7528}'],
      },
      { id: 'migration', alternatives: ['online schema migration', '\u{5728}\u{7EBF} schema \u{8FC1}\u{79FB}'] },
      {
        id: 'upgrade',
        alternatives: ['5.x upgrade path', 'upgrade path from 5.x', '5.x \u{5347}\u{7EA7}\u{8DEF}\u{5F84}'],
      },
      { id: 'compatibility', alternatives: ['compatibility mode', '\u{517C}\u{5BB9}\u{6A21}\u{5F0F}'] },
    ],
    forbiddenClaims: [
      {
        id: 'zero-downtime',
        alternatives: [
          'guarantees zero downtime',
          '\u{4FDD}\u{8BC1}\u{96F6}\u{505C}\u{673A}',
          '\u{4FDD}\u{8BC1}\u{4E0D}\u{505C}\u{673A}',
        ],
      },
    ],
  },
]

const legacyCommonGate =
  'Decide whether the story contains material new information for the configured audience, not merely whether it is topically related. Reject placeholders, stale or duplicate coverage, promotional copy, unsupported predictions, and opinion presented as fact. Every approved claim must point to supplied evidence.'
const legacyCommonArticle =
  'Write only from approved claims and explicit uncertainty. Attribute source-specific statements and do not invent facts, quotations, figures, chronology, links, or sources. Choose length from the amount of evidence. Avoid repetition, padding, generic scene-setting, boilerplate conclusions, and calls to action.'

const legacyProfiles: Readonly<Record<LegacyProfileId, EditorialProfile>> = {
  news: {
    id: 'general',
    admissionPrompt:
      'Prioritize fresh, specific developments with a clear change, actor, time frame, and reader consequence. Demote commentary and recycled announcements.',
    gatePrompt: `${legacyCommonGate} Prefer authoritative or primary reporting and keep the article tightly bounded when only one source establishes the development.`,
    articlePrompt: `${legacyCommonArticle} Lead with the new development, then explain why it matters and the minimum supported context.`,
    minimumEvidenceSources: 1,
    storyBlocks: [
      { kind: 'lead' },
      { kind: 'key-points' },
      { kind: 'context', tools: ['web-search'] },
      { kind: 'uncertainty', tools: ['web-search'] },
    ],
    maximumEnrichedStoriesPerRun: 2,
    maximumEnrichmentResultsPerStory: 2,
  },
  briefing: {
    id: 'briefing',
    admissionPrompt:
      'Prioritize actionable changes and a balanced mix of distinct topics. Prefer concise items with concrete consequences over incremental noise.',
    gatePrompt: `${legacyCommonGate} Approve only developments that can be summarized into a compact briefing with a concrete reader takeaway.`,
    articlePrompt: `${legacyCommonArticle} Use a concise briefing structure: state the development, key points, consequence, and what remains unresolved.`,
    minimumEvidenceSources: 1,
    storyBlocks: [
      { kind: 'lead' },
      { kind: 'key-points' },
      { kind: 'context', tools: ['web-search'] },
      { kind: 'watch', tools: ['web-search'] },
    ],
    maximumEnrichedStoriesPerRun: 3,
    maximumEnrichmentResultsPerStory: 2,
  },
  analysis: {
    id: 'analysis',
    admissionPrompt:
      'Prioritize developments with enough independent material for explanation, comparison, or causal context. Demote thin announcements that support only a short update.',
    gatePrompt: `${legacyCommonGate} Require multiple evidence sources for interpretive claims and keep inference visibly separate from established facts.`,
    articlePrompt: `${legacyCommonArticle} Build an evidence-led explanation with context, analysis tied to cited claims, and explicit caveats.`,
    minimumEvidenceSources: 2,
    storyBlocks: [
      { kind: 'lead' },
      { kind: 'key-points' },
      { kind: 'context', tools: ['web-search'] },
      { kind: 'analysis', tools: ['web-search'] },
      { kind: 'uncertainty', tools: ['web-search'] },
      { kind: 'watch' },
    ],
    maximumEnrichedStoriesPerRun: 5,
    maximumEnrichmentResultsPerStory: 3,
  },
}

const beforeProfileMapping: Readonly<Record<EditorialProfileId, LegacyProfileId>> = {
  general: 'news',
  briefing: 'briefing',
  analysis: 'analysis',
  explainer: 'analysis',
  'research-review': 'analysis',
  'risk-advisory': 'news',
  'policy-tracker': 'news',
  'market-intelligence': 'news',
  'product-update': 'news',
}

function editorialConfig(profile: EditorialProfile, language: EvalLanguage): EditorialConfig {
  return {
    profile,
    instructions: instructions[language],
    gatePrompt: DEFAULT_GATE_PROMPT,
    articlePrompt: DEFAULT_ARTICLE_PROMPT,
    languages: [language],
    publishThreshold: 0.75,
    deduplicationContextSize: 50,
  }
}

function includesAny(text: string, alternatives: readonly string[]): boolean {
  const normalize = (value: string): string =>
    value
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .replace(/[^\p{L}\p{N}%$]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
  const normalized = normalize(text)
  return alternatives.some((alternative) => normalized.includes(normalize(alternative)))
}

function matchesFact(text: string, fact: RequiredFact): boolean {
  return includesAny(text, fact.alternatives) || Boolean(fact.allOf?.every((group) => includesAny(text, group)))
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length
}

function normalizedCharacters(text: string): readonly string[] {
  return [
    ...text
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ''),
  ]
}

function characterTrigrams(text: string): ReadonlySet<string> {
  const characters = normalizedCharacters(text)
  if (characters.length < 3) return new Set(characters.length === 0 ? [] : [characters.join('')])
  return new Set(characters.slice(0, -2).map((_, index) => characters.slice(index, index + 3).join('')))
}

function diceSimilarity(left: string, right: string): number {
  const leftGrams = characterTrigrams(left)
  const rightGrams = characterTrigrams(right)
  if (leftGrams.size + rightGrams.size === 0) return 1
  let intersection = 0
  for (const gram of leftGrams) if (rightGrams.has(gram)) intersection += 1
  return (2 * intersection) / (leftGrams.size + rightGrams.size)
}

function matchesProfileStructure(article: GeneratedArticle, profile: EditorialProfile): boolean {
  const actualKinds = article.blocks.map(({ kind }) => kind)
  const actualKindSet = new Set(actualKinds)
  const configuredIndexes = actualKinds.map((kind) => profile.storyBlocks.findIndex((block) => block.kind === kind))
  return (
    actualKinds.length === actualKindSet.size &&
    configuredIndexes.every((index) => index >= 0) &&
    configuredIndexes.every((index, position) => position === 0 || index > (configuredIndexes[position - 1] ?? -1)) &&
    profile.storyBlocks.every((block) => block.optional || actualKindSet.has(block.kind))
  )
}

export function scoreProfileArticle(
  evalCase: ArticleEvalCase,
  article: GeneratedArticle,
): Omit<ArticleResult, 'id' | 'profileId' | 'output' | 'responses' | 'error' | 'durationMs'> {
  const text = `${article.title}\n${article.summary}\n${article.body}`
  const missingFactIds = evalCase.requiredFacts.filter((fact) => !matchesFact(text, fact)).map((fact) => fact.id)
  const factMatches = evalCase.requiredFacts.length - missingFactIds.length
  const forbiddenClaims = evalCase.forbiddenClaims.filter((fact) => matchesFact(text, fact)).length
  const bodyWords = wordCount(article.body)
  const isChinese = article.language === 'zh-CN'
  let stylePassed =
    !/\b(?:shocking|game[ -]?changing|you won\W?t believe)\b|\u{9707}\u{60CA}|\u{98A0}\u{8986}\u{6027}|\u{4E0D}\u{6562}\u{76F8}\u{4FE1}/iu.test(
      article.title,
    )
  if (evalCase.profileId === 'briefing') stylePassed &&= article.body.length <= 1_200
  if (['general', 'market-intelligence', 'product-update'].includes(evalCase.profileId))
    stylePassed &&= isChinese ? normalizedCharacters(article.title).length <= 60 : wordCount(article.title) <= 20
  if (evalCase.profileId === 'explainer') stylePassed &&= isChinese ? article.body.length <= 700 : bodyWords <= 350
  const structurePassed = matchesProfileStructure(article, editorialProfiles[evalCase.profileId])
  const summaryDistinct = article.blocks.every((block) => diceSimilarity(article.summary, block.markdown) < 0.82)
  const factRecall = evalCase.requiredFacts.length === 0 ? 1 : factMatches / evalCase.requiredFacts.length
  return {
    factMatches,
    factTotal: evalCase.requiredFacts.length,
    forbiddenClaims,
    missingFactIds,
    stylePassed,
    structurePassed,
    summaryDistinct,
    passed:
      factRecall >= profilePromptThresholds.minimumArticleFactRecall &&
      forbiddenClaims === 0 &&
      stylePassed &&
      structurePassed &&
      summaryDistinct,
  }
}

function completionContent(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return undefined
  const first = choices[0]
  if (!first || typeof first !== 'object') return undefined
  const message = (first as { message?: unknown }).message
  if (!message || typeof message !== 'object') return undefined
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' ? content : undefined
}

function captureResponses(client: AiClient): { readonly client: AiClient; readonly responses: string[] } {
  const responses: string[] = []
  return {
    responses,
    client: {
      async complete(request) {
        const result = await client.complete(request)
        const content = completionContent(result)
        if (content !== undefined) responses.push(`[${request.operation}] ${content}`)
        return result
      },
    },
  }
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

function metrics(gates: readonly GateResult[], articles: readonly ArticleResult[]): ProfilePromptMetrics {
  const factMatches = articles.reduce((total, article) => total + article.factMatches, 0)
  const factTotal = articles.reduce((total, article) => total + article.factTotal, 0)
  return {
    gateAccuracy: gates.length === 0 ? 1 : gates.filter(({ passed }) => passed).length / gates.length,
    criticalFalsePositives: gates.filter(({ criticalFalsePositive }) => criticalFalsePositive).length,
    articleFactRecall: factTotal === 0 ? 1 : factMatches / factTotal,
    articleStyleRate:
      articles.length === 0 ? 1 : articles.filter(({ stylePassed }) => stylePassed).length / articles.length,
    articleStructureRate:
      articles.length === 0 ? 1 : articles.filter(({ structurePassed }) => structurePassed).length / articles.length,
    summaryDistinctRate:
      articles.length === 0 ? 1 : articles.filter(({ summaryDistinct }) => summaryDistinct).length / articles.length,
    articlePassRate: articles.length === 0 ? 1 : articles.filter(({ passed }) => passed).length / articles.length,
    forbiddenClaims: articles.reduce((total, article) => total + article.forbiddenClaims, 0),
    errors: [...gates, ...articles].filter(({ error }) => error !== undefined).length,
  }
}

function suiteResult(gates: readonly GateResult[], articles: readonly ArticleResult[]): SuiteResult {
  const profiles: Partial<Record<EditorialProfileId, ProfilePromptMetrics>> = {}
  for (const profileId of editorialProfileIds) {
    const profileGates = gates.filter((result) => result.profileId === profileId)
    const profileArticles = articles.filter((result) => result.profileId === profileId)
    if (profileGates.length + profileArticles.length > 0) profiles[profileId] = metrics(profileGates, profileArticles)
  }
  return { metrics: metrics(gates, articles), profiles, gates, articles }
}

async function evaluateSuite(
  profileFor: (id: EditorialProfileId) => EditorialProfile,
  client: AiClient,
  concurrency: number,
  language: EvalLanguage,
): Promise<SuiteResult> {
  const gates = await mapLimit(profileGateCases, concurrency, async (evalCase): Promise<GateResult> => {
    const started = performance.now()
    const capture = captureResponses(client)
    try {
      const decision = await createEditorial(
        editorialConfig(profileFor(evalCase.profileId), language),
        capture.client,
      ).evaluate(evalCase.candidate, [])
      return {
        id: evalCase.id,
        profileId: evalCase.profileId,
        expectedPublish: evalCase.expectedPublish,
        passed: decision.publish === evalCase.expectedPublish,
        criticalFalsePositive: Boolean(evalCase.critical && !evalCase.expectedPublish && decision.publish),
        actualPublish: decision.publish,
        score: decision.score,
        reason: decision.reason,
        responses: capture.responses,
        durationMs: Math.round(performance.now() - started),
      }
    } catch (error) {
      return {
        id: evalCase.id,
        profileId: evalCase.profileId,
        expectedPublish: evalCase.expectedPublish,
        passed: false,
        criticalFalsePositive: false,
        responses: capture.responses,
        error: errorMessage(error),
        durationMs: Math.round(performance.now() - started),
      }
    }
  })
  const articles = await mapLimit(profileArticleCases, concurrency, async (evalCase): Promise<ArticleResult> => {
    const started = performance.now()
    const capture = captureResponses(client)
    try {
      const sourceUrls = candidateReports(evalCase.candidate).map((report) => report.canonicalUrl)
      const decision: GateDecision = {
        publish: true,
        score: 0.95,
        reason: 'Approved profile evaluation fixture.',
        topics: [evalCase.profileId],
        risks: [],
        claims: evalCase.claims,
        uncertainties: [],
        sourceUrls,
      }
      const generated = await createEditorial(
        editorialConfig(profileFor(evalCase.profileId), language),
        capture.client,
      ).generate(evalCase.candidate, decision)
      const article = generated[0]
      if (!article) throw new Error('AI response did not contain an article')
      return {
        id: evalCase.id,
        profileId: evalCase.profileId,
        ...scoreProfileArticle(evalCase, article),
        output: article,
        responses: capture.responses,
        durationMs: Math.round(performance.now() - started),
      }
    } catch (error) {
      return {
        id: evalCase.id,
        profileId: evalCase.profileId,
        factMatches: 0,
        factTotal: evalCase.requiredFacts.length,
        forbiddenClaims: 0,
        missingFactIds: evalCase.requiredFacts.map((fact) => fact.id),
        stylePassed: false,
        structurePassed: false,
        summaryDistinct: false,
        passed: false,
        responses: capture.responses,
        error: errorMessage(error),
        durationMs: Math.round(performance.now() - started),
      }
    }
  })
  return suiteResult(gates, articles)
}

function comparisonDelta(before: ProfilePromptMetrics, after: ProfilePromptMetrics) {
  return {
    gateAccuracy: after.gateAccuracy - before.gateAccuracy,
    articleFactRecall: after.articleFactRecall - before.articleFactRecall,
    articleStyleRate: after.articleStyleRate - before.articleStyleRate,
    articleStructureRate: after.articleStructureRate - before.articleStructureRate,
    summaryDistinctRate: after.summaryDistinctRate - before.summaryDistinctRate,
    articlePassRate: after.articlePassRate - before.articlePassRate,
  }
}

function profileMinimumPasses(metrics: ProfilePromptMetrics): boolean {
  return (
    metrics.gateAccuracy >= profilePromptThresholds.minimumProfileGateAccuracy &&
    metrics.articleFactRecall >= profilePromptThresholds.minimumProfileFactRecall &&
    metrics.articleStructureRate === profilePromptThresholds.articleStructureRate &&
    metrics.criticalFalsePositives === 0 &&
    metrics.forbiddenClaims === 0 &&
    metrics.errors === 0
  )
}

export function profileComparisonPasses(before: ProfilePromptEvaluation, after: ProfilePromptEvaluation): boolean {
  const { metrics } = after
  const delta = comparisonDelta(before.metrics, metrics)
  const noMaterialRegression = [
    delta.gateAccuracy,
    delta.articleFactRecall,
    delta.articleStyleRate,
    delta.summaryDistinctRate,
    delta.articlePassRate,
  ].every((value) => value >= -profilePromptThresholds.maximumRegression)
  return (
    metrics.gateAccuracy >= profilePromptThresholds.gateAccuracy &&
    metrics.criticalFalsePositives === 0 &&
    metrics.articleFactRecall >= profilePromptThresholds.articleFactRecall &&
    metrics.articleStyleRate >= profilePromptThresholds.articleStyleRate &&
    metrics.articleStructureRate === profilePromptThresholds.articleStructureRate &&
    metrics.summaryDistinctRate >= profilePromptThresholds.summaryDistinctRate &&
    metrics.articlePassRate >= profilePromptThresholds.articlePassRate &&
    metrics.forbiddenClaims === 0 &&
    metrics.errors === 0 &&
    editorialProfileIds.every((profileId) => {
      const profile = after.profiles[profileId]
      return profile !== undefined && profileMinimumPasses(profile)
    }) &&
    noMaterialRegression &&
    delta.articleStructureRate >= profilePromptThresholds.minimumStructureImprovement
  )
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function signedPercentage(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`
}

function printSummary(report: ProfilePromptReport): void {
  console.log(
    `Profile prompt eval: ${report.provider}/${report.model} language=${report.language} dataset=${report.datasetHash.slice(0, 12)}`,
  )
  console.log('profile              gate    facts   style   shape   distinct articles  forbidden errors')
  for (const id of editorialProfileIds) {
    const result = report.current.profiles[id]
    if (!result) continue
    console.log(
      `${id.padEnd(20)} ${percentage(result.gateAccuracy).padEnd(7)} ${percentage(result.articleFactRecall).padEnd(7)} ${percentage(result.articleStyleRate).padEnd(7)} ${percentage(result.articleStructureRate).padEnd(7)} ${percentage(result.summaryDistinctRate).padEnd(8)} ${percentage(result.articlePassRate).padEnd(9)} ${String(result.forbiddenClaims).padEnd(9)} ${result.errors}`,
    )
  }
  const { before, after, delta } = report.comparison
  console.log('legacy generic prompts -> publication-task profiles')
  console.log(
    `gate ${percentage(before.metrics.gateAccuracy)} -> ${percentage(after.metrics.gateAccuracy)} (${signedPercentage(delta.gateAccuracy)})`,
  )
  console.log(
    `facts ${percentage(before.metrics.articleFactRecall)} -> ${percentage(after.metrics.articleFactRecall)} (${signedPercentage(delta.articleFactRecall)})`,
  )
  console.log(
    `style ${percentage(before.metrics.articleStyleRate)} -> ${percentage(after.metrics.articleStyleRate)} (${signedPercentage(delta.articleStyleRate)})`,
  )
  console.log(
    `shape ${percentage(before.metrics.articleStructureRate)} -> ${percentage(after.metrics.articleStructureRate)} (${signedPercentage(delta.articleStructureRate)})`,
  )
  console.log(
    `distinct ${percentage(before.metrics.summaryDistinctRate)} -> ${percentage(after.metrics.summaryDistinctRate)} (${signedPercentage(delta.summaryDistinctRate)})`,
  )
  console.log(
    `articles ${percentage(before.metrics.articlePassRate)} -> ${percentage(after.metrics.articlePassRate)} (${signedPercentage(delta.articlePassRate)})`,
  )
  console.log(`result ${report.passed ? 'PASS' : 'FAIL'}`)
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

function evalLanguage(): EvalLanguage {
  const language = optionValue('language') ?? 'en'
  if (language === 'en' || language === 'zh-CN') return language
  throw new Error('language must be en or zh-CN')
}

function aiConfig(): AiConfig {
  const apiKey = process.env.AI_API_KEY?.trim() || process.env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) throw new Error('AI_API_KEY or DEEPSEEK_API_KEY is required for profile prompt eval')
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
  const language = evalLanguage()
  const concurrency = positiveInteger(
    optionValue('concurrency') ?? process.env.PROMPT_EVAL_CONCURRENCY,
    4,
    'concurrency',
  )
  const startedAt = new Date().toISOString()
  const client = createOpenAiClient(config)
  const current = await evaluateSuite((id) => editorialProfiles[id], client, concurrency, language)
  const before = await evaluateSuite((id) => legacyProfiles[beforeProfileMapping[id]], client, concurrency, language)
  const delta = comparisonDelta(before.metrics, current.metrics)
  const report: ProfilePromptReport = {
    schemaVersion: 3,
    datasetHash: createHash('sha256')
      .update(JSON.stringify({ language, thresholds: profilePromptThresholds, profileGateCases, profileArticleCases }))
      .digest('hex'),
    beforeProfileHash: createHash('sha256')
      .update(JSON.stringify({ beforeProfileMapping, legacyProfiles }))
      .digest('hex'),
    currentProfileHash: createHash('sha256').update(JSON.stringify(editorialProfiles)).digest('hex'),
    provider: config.provider,
    model: config.model,
    language,
    thresholds: profilePromptThresholds,
    startedAt,
    finishedAt: new Date().toISOString(),
    passed: profileComparisonPasses(before, current),
    current,
    comparison: { before, after: current, delta },
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
