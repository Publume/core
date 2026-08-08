import { describe, expect, it } from 'bun:test'
import {
  profileArticleCases,
  profileComparisonPasses,
  profileGateCases,
  scoreProfileArticle,
} from '../scripts/profile-prompt-eval'
import { editorialProfileIds } from '../src/config/profiles'

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
  })

  it('scores required details and unsafe widening independently', () => {
    const evalCase = profileArticleCases.find(({ profileId }) => profileId === 'risk-advisory')
    expect(evalCase).toBeDefined()
    if (!evalCase) return

    const valid = scoreProfileArticle(evalCase, {
      title: 'AcmeGateway 4.2–4.5 flaw is actively exploited',
      summary: 'Version 4.5.1 fixes the issue affecting admin panels reachable from the internet.',
      body: 'The advisory covers versions 4.2 through 4.5 and says the flaw is exploited. Operators should update to 4.5.1 and limit admin-panel access.',
    })
    expect(valid).toMatchObject({ factMatches: 5, forbiddenClaims: 0, passed: true })

    const widened = scoreProfileArticle(evalCase, {
      title: 'All AcmeGateway versions are compromised',
      summary: 'Every AcmeGateway is compromised.',
      body: 'Upgrade immediately.',
    })
    expect(widened.passed).toBe(false)
    expect(widened.forbiddenClaims).toBe(1)
  })

  it('requires a non-regressing paired result with at least one improvement', () => {
    const before = {
      gateAccuracy: 0.85,
      criticalFalsePositives: 0,
      articleFactRecall: 0.9,
      articlePassRate: 2 / 3,
      errors: 0,
    }
    const after = { ...before, gateAccuracy: 1, articleFactRecall: 1, articlePassRate: 1 }
    expect(profileComparisonPasses(before, after)).toBe(true)
    expect(profileComparisonPasses(before, before)).toBe(false)
    expect(profileComparisonPasses(before, { ...after, criticalFalsePositives: 1 })).toBe(false)
  })
})
