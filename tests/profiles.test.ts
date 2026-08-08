import { describe, expect, it } from 'bun:test'
import { editorialProfile, editorialProfileIds, editorialProfiles } from '../src/config/profiles'

describe('editorial profiles', () => {
  it('defines publication-task profiles without coupling them to subject categories', () => {
    expect(editorialProfileIds).toEqual([
      'general',
      'briefing',
      'analysis',
      'explainer',
      'research-review',
      'risk-advisory',
      'policy-tracker',
      'market-intelligence',
      'product-update',
    ])
    expect(editorialProfiles.explainer.storyBlocks).toEqual([
      { kind: 'background' },
      { kind: 'solution' },
      { kind: 'takeaway' },
    ])
    expect(editorialProfiles.general.minimumEvidenceSources).toBe(1)
    expect(editorialProfiles.analysis.minimumEvidenceSources).toBe(2)
  })

  it('defines one ordered block contract and bounded enrichment policy per profile', () => {
    const requiredFingerprints: string[] = []
    for (const profile of Object.values(editorialProfiles)) {
      const kinds = profile.storyBlocks.map(({ kind }) => kind)
      const requiredKinds = profile.storyBlocks.filter((block) => !block.optional).map(({ kind }) => kind)
      expect(new Set(kinds).size).toBe(kinds.length)
      expect(requiredKinds.length).toBeGreaterThan(0)
      expect(kinds).not.toContain('summary')
      expect(profile.admissionPrompt.length).toBeGreaterThan(80)
      expect(profile.gatePrompt.length).toBeGreaterThan(150)
      expect(profile.articlePrompt.length).toBeGreaterThan(150)
      requiredFingerprints.push(requiredKinds.join('>'))
      if (!profile.storyBlocks.some((block) => block.tools?.includes('web-search'))) {
        expect(profile.maximumEnrichedStoriesPerRun).toBe(0)
        expect(profile.maximumEnrichmentResultsPerStory).toBe(0)
      }
    }
    expect(new Set(requiredFingerprints).size).toBe(editorialProfileIds.length)
  })

  it('fails closed for an unknown deployment profile', () => {
    expect(() => editorialProfile('unknown')).toThrow('Unsupported SITE_TYPE')
  })
})
