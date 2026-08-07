import { describe, expect, it } from 'bun:test'
import {
  articleCases,
  gateCases,
  promptVariants,
  scoreArticleCase,
  scoreGateCase,
  variantPasses,
} from '../scripts/prompt-eval'

describe('prompt evaluation', () => {
  it('uses a representative, uniquely identified comparison set', () => {
    expect(gateCases).toHaveLength(24)
    expect(articleCases).toHaveLength(6)
    expect(new Set([...gateCases, ...articleCases].map(({ id }) => id)).size).toBe(30)
    expect(promptVariants.map(({ id }) => id)).toEqual(['legacy-core', 'reference-baseline', 'current-core'])
    for (const variant of promptVariants)
      expect(`${variant.gatePrompt}\n${variant.articlePrompt}`).not.toMatch(/\p{Script=Han}/u)
  })

  it('scores gate classification, risk tags, and critical false positives separately', () => {
    const fixture = gateCases.find(({ id }) => id === 'fixture-content')
    expect(fixture).toBeDefined()
    if (!fixture) return

    const rejection = scoreGateCase(fixture, {
      publish: false,
      score: 0.05,
      reason: 'This is a fixture, not publishable information.',
      topics: [],
      risks: ['unsafe'],
    })
    expect(rejection).toMatchObject({ classificationPassed: true, criticalFalsePositive: false })

    const falsePositive = scoreGateCase(fixture, {
      publish: true,
      score: 0.95,
      reason: 'Looks important.',
      topics: ['testing'],
      risks: [],
    })
    expect(falsePositive).toMatchObject({ classificationPassed: false, criticalFalsePositive: true })
  })

  it('reports missing source facts, invented claims, and weak article structure', () => {
    const evalCase = articleCases[0]
    expect(evalCase).toBeDefined()
    if (!evalCase) return

    const valid = scoreArticleCase(evalCase, {
      language: 'en',
      title: 'Orion 4.2 adds Linux support and fixes CVE-2026-4410',
      summary: 'Orion 4.2 adds Linux support and fixes CVE-2026-4410 for affected deployments.',
      body: 'Orion 4.2 is now available with Linux support and a fix for CVE-2026-4410. The vendor says Windows behavior is unchanged. Operators can use the release notes to determine whether their deployments are affected.',
      sourceUrls: [evalCase.candidate.canonicalUrl],
    })
    expect(valid.passed).toBe(true)

    const invalid = scoreArticleCase(evalCase, {
      language: 'en',
      title: 'Shocking release changes everything',
      summary: 'A release happened. You will not believe what happens next. Everyone must upgrade.',
      body: 'In conclusion, macOS performance doubled.',
      sourceUrls: [evalCase.candidate.canonicalUrl],
    })
    expect(invalid.passed).toBe(false)
    expect(invalid.failures).toContain('missing-fact:orion-version')
    expect(invalid.failures).toContain('forbidden-claim:macos-support')
    expect(invalid.failures).toContain('clickbait-title')
    expect(invalid.failures).toContain('summary-sentence-count')
    expect(invalid.failures).toContain('generic-conclusion')
  })

  it('applies the release gate only to the required prompt variant', () => {
    expect(
      variantPasses(
        {
          gateClassificationAccuracy: 0.95,
          gateRiskAccuracy: 0.8,
          criticalFalsePositives: 0,
          articlePassRate: 0.84,
          errors: 0,
        },
        'current-core',
      ),
    ).toBe(true)
    expect(
      variantPasses(
        {
          gateClassificationAccuracy: 0.7,
          gateRiskAccuracy: 0.5,
          criticalFalsePositives: 2,
          articlePassRate: 0.5,
          errors: 0,
        },
        'legacy-core',
      ),
    ).toBe(true)
    expect(
      variantPasses(
        {
          gateClassificationAccuracy: 0.89,
          gateRiskAccuracy: 0.9,
          criticalFalsePositives: 0,
          articlePassRate: 1,
          errors: 0,
        },
        'current-core',
      ),
    ).toBe(false)
  })
})
