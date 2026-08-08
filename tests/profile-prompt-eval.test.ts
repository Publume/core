import { describe, expect, it } from 'bun:test'
import {
  type ProfilePromptEvaluation,
  type ProfilePromptMetrics,
  profileArticleCases,
  profileComparisonPasses,
  profileGateCases,
  scoreProfileArticle,
} from '../scripts/profile-prompt-eval'
import { type EditorialProfileId, editorialProfileIds } from '../src/config/profiles'
import type { GeneratedArticle, StoryBlockKind } from '../src/domain/content'

const sourceUrl = 'https://security.example.gov/advisories/cve-2026-4410'

function generatedArticle(
  title: string,
  summary: string,
  blocks: readonly { readonly kind: StoryBlockKind; readonly markdown: string }[],
  language = 'en',
): GeneratedArticle {
  const populatedBlocks = blocks.map((block, index) => ({
    id: `block-${index + 1}`,
    ...block,
    claimIds: ['claim-1'],
    uncertaintyIds: [],
    sourceUrls: [sourceUrl],
  }))
  return {
    language,
    title,
    summary,
    body: populatedBlocks.map(({ markdown }) => markdown).join('\n\n'),
    blocks: populatedBlocks,
    sourceUrls: [sourceUrl],
  }
}

function promptMetrics(overrides: Partial<ProfilePromptMetrics> = {}): ProfilePromptMetrics {
  return {
    gateAccuracy: 1,
    criticalFalsePositives: 0,
    articleFactRecall: 1,
    articleStyleRate: 1,
    articleStructureRate: 1,
    summaryDistinctRate: 1,
    articlePassRate: 1,
    forbiddenClaims: 0,
    errors: 0,
    ...overrides,
  }
}

function evaluation(
  metrics: ProfilePromptMetrics,
  profileOverrides: Readonly<Partial<Record<EditorialProfileId, ProfilePromptMetrics>>> = {},
): ProfilePromptEvaluation {
  const profiles: Partial<Record<EditorialProfileId, ProfilePromptMetrics>> = {}
  for (const profileId of editorialProfileIds)
    profiles[profileId] = profileOverrides[profileId] ?? promptMetrics({ articleFactRecall: 0.8 })
  return { metrics, profiles }
}

describe('editorial profile prompt evaluation', () => {
  it('covers every publishing task with two gate cases and one article case', () => {
    expect(profileGateCases).toHaveLength(editorialProfileIds.length * 2)
    expect(profileArticleCases).toHaveLength(editorialProfileIds.length)
    expect(new Set([...profileGateCases, ...profileArticleCases].map(({ id }) => id)).size).toBe(
      profileGateCases.length + profileArticleCases.length,
    )

    for (const profileId of editorialProfileIds) {
      expect(profileGateCases.filter((evalCase) => evalCase.profileId === profileId)).toHaveLength(2)
      expect(profileArticleCases.filter((evalCase) => evalCase.profileId === profileId)).toHaveLength(1)
    }
    expect(profileArticleCases.reduce((total, evalCase) => total + evalCase.requiredFacts.length, 0)).toBe(42)
  })

  it('scores required details and unsafe widening independently', () => {
    const evalCase = profileArticleCases.find(({ profileId }) => profileId === 'risk-advisory')
    expect(evalCase).toBeDefined()
    if (!evalCase) return

    const validArticle = generatedArticle(
      'AcmeGateway 4.2–4.5 flaw is actively exploited',
      'Version 4.5.1 fixes the issue affecting admin panels reachable from the internet.',
      [
        {
          kind: 'impact',
          markdown: 'Affected: versions 4.2 through 4.5 with internet-exposed admin panels; status: exploited.',
        },
        { kind: 'solution', markdown: 'Update to 4.5.1 and restrict admin access.' },
      ],
    )
    const valid = scoreProfileArticle(evalCase, validArticle)
    expect(valid).toMatchObject({ factMatches: 5, forbiddenClaims: 0, passed: true })

    const partial = scoreProfileArticle(
      evalCase,
      generatedArticle(
        'AcmeGateway 4.2–4.5 flaw is actively exploited',
        'Version 4.5.1 fixes the issue affecting internet-exposed admin panels.',
        [
          { kind: 'impact', markdown: 'Versions 4.2 through 4.5 are exploited when admin panels are exposed.' },
          { kind: 'solution', markdown: 'Update to 4.5.1.' },
        ],
      ),
    )
    expect(partial).toMatchObject({ factMatches: 4, forbiddenClaims: 0, passed: true })

    const widened = scoreProfileArticle(
      evalCase,
      generatedArticle('All AcmeGateway versions are compromised', 'Every AcmeGateway is compromised.', [
        { kind: 'impact', markdown: 'All versions are compromised.' },
        { kind: 'solution', markdown: 'Upgrade immediately.' },
      ]),
    )
    expect(widened.passed).toBe(false)
    expect(widened.forbiddenClaims).toBe(1)

    const wrongShape = scoreProfileArticle(evalCase, {
      ...validArticle,
      blocks: [...validArticle.blocks].reverse(),
    })
    expect(wrongShape.structurePassed).toBe(false)

    const repeatedSummary = scoreProfileArticle(evalCase, {
      ...validArticle,
      body: `${validArticle.summary}\n\n${validArticle.blocks[1]?.markdown ?? ''}`,
      blocks: validArticle.blocks.map((block, index) =>
        index === 0 ? { ...block, markdown: validArticle.summary } : block,
      ),
    })
    expect(repeatedSummary.summaryDistinct).toBe(false)
  })

  it('scores Chinese facts and rejects unsupported Chinese additions', () => {
    const evalCase = profileArticleCases.find(({ profileId }) => profileId === 'research-review')
    expect(evalCase).toBeDefined()
    if (!evalCase) return

    const validArticle = generatedArticle(
      '\u{968F}\u{673A}\u{7814}\u{7A76}\u{663E}\u{793A}\u{6559}\u{5BA4}\u{9897}\u{7C92}\u{7269}\u{66B4}\u{9732}\u{4E0B}\u{964D}',
      '\u{4E00}\u{9879}\u{540C}\u{884C}\u{8BC4}\u{5BA1}\u{7814}\u{7A76}\u{89C2}\u{5BDF}\u{5230}\u{8F83}\u{4F4E}\u{7684}\u{9897}\u{7C92}\u{7269}\u{66B4}\u{9732}\u{FF0C}\u{4F46}\u{6CA1}\u{6709}\u{6D4B}\u{91CF}\u{5065}\u{5EB7}\u{7ED3}\u{679C}\u{3002}',
      [
        {
          kind: 'background',
          markdown:
            '\u{8FD9}\u{9879}\u{968F}\u{673A}\u{5BF9}\u{7167}\u{7814}\u{7A76}\u{7EB3}\u{5165}120\u{95F4}\u{6559}\u{5BA4}\u{FF0C}\u{6301}\u{7EED}12\u{5468}\u{3002}',
        },
        {
          kind: 'analysis',
          markdown:
            '\u{4E0E}\u{5BF9}\u{7167}\u{7EC4}\u{76F8}\u{6BD4}\u{FF0C}\u{8FC7}\u{6EE4}\u{5668}\u{7EC4}\u{7684}\u{5E73}\u{5747}PM2.5\u{66B4}\u{9732}\u{964D}\u{4F4E}18%\u{3002}',
        },
        {
          kind: 'uncertainty',
          markdown:
            '\u{7814}\u{7A76}\u{672A}\u{6D4B}\u{91CF}\u{547C}\u{5438}\u{7ED3}\u{5C40}\u{FF0C}\u{7ED3}\u{679C}\u{4E0D}\u{80FD}\u{5916}\u{63A8}\u{5230}\u{5065}\u{5EB7}\u{5F71}\u{54CD}\u{3002}',
        },
      ],
      'zh-CN',
    )
    expect(scoreProfileArticle(evalCase, validArticle)).toMatchObject({
      factMatches: 5,
      forbiddenClaims: 0,
      passed: true,
    })

    const invented = scoreProfileArticle(evalCase, {
      ...validArticle,
      body: `${validArticle.body}\n\u{7814}\u{7A76}\u{8FD8}\u{51CF}\u{5C11}\u{4E86}\u{54B3}\u{55FD}\u{3002}`,
      blocks: validArticle.blocks.map((block, index) =>
        index === 1
          ? {
              ...block,
              markdown: `${block.markdown} \u{7814}\u{7A76}\u{8FD8}\u{51CF}\u{5C11}\u{4E86}\u{54B3}\u{55FD}\u{3002}`,
            }
          : block,
      ),
    })
    expect(invented.forbiddenClaims).toBe(1)
    expect(invented.passed).toBe(false)
  })

  it('balances aggregate quality, profile floors, and hard safety constraints', () => {
    const before = evaluation(
      promptMetrics({
        gateAccuracy: 0.89,
        articleFactRecall: 0.91,
        articleStyleRate: 0.9,
        articleStructureRate: 0.2,
        summaryDistinctRate: 0.9,
        articlePassRate: 0.75,
      }),
    )
    const after = evaluation(
      promptMetrics({
        gateAccuracy: 0.94,
        articleFactRecall: 0.92,
        articleStyleRate: 0.89,
        summaryDistinctRate: 0.89,
        articlePassRate: 8 / 9,
      }),
    )
    expect(profileComparisonPasses(before, after)).toBe(true)
    expect(profileComparisonPasses(before, evaluation(promptMetrics({ ...after.metrics, gateAccuracy: 0.89 })))).toBe(
      false,
    )
    expect(
      profileComparisonPasses(before, evaluation(promptMetrics({ ...after.metrics, articlePassRate: 0.79 }))),
    ).toBe(false)
    expect(profileComparisonPasses(evaluation(promptMetrics({ articleStructureRate: 0.8 })), after)).toBe(false)
    expect(
      profileComparisonPasses(before, evaluation(promptMetrics({ ...after.metrics, criticalFalsePositives: 1 }))),
    ).toBe(false)
    expect(profileComparisonPasses(before, evaluation(promptMetrics({ ...after.metrics, forbiddenClaims: 1 })))).toBe(
      false,
    )
    expect(
      profileComparisonPasses(
        before,
        evaluation(after.metrics, { general: promptMetrics({ articleFactRecall: 0.69 }) }),
      ),
    ).toBe(false)
    expect(
      profileComparisonPasses(
        evaluation(promptMetrics({ articleStructureRate: 0.2 })),
        evaluation(promptMetrics({ ...after.metrics, articleStyleRate: 0.86 })),
      ),
    ).toBe(false)
  })
})
