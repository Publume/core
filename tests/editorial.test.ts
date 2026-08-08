import { describe, expect, it } from 'bun:test'
import { createEditorial } from '../src/adapters/editorial'
import type { AiClient } from '../src/adapters/openai'
import type { EditorialConfig } from '../src/config/model'
import { editorialProfiles } from '../src/config/profiles'
import type { Candidate, GateDecision } from '../src/domain/content'

const config: EditorialConfig = {
  profile: editorialProfiles.general,
  instructions: 'Publish source-backed updates.',
  gatePrompt: 'Evaluate the candidate.',
  articlePrompt: 'Write the article.',
  languages: ['en'],
  publishThreshold: 0.75,
  deduplicationContextSize: 50,
}

const candidate: Candidate = {
  sourceId: 'source-1',
  externalId: 'entry-1',
  canonicalUrl: 'https://source.example/article',
  title: 'Source article',
  content: 'Source-backed content.',
  contentOrigin: 'article-page',
}

const decision: GateDecision = {
  publish: true,
  score: 0.9,
  reason: 'important',
  topics: ['technology'],
  risks: [],
  claims: [
    {
      id: 'claim-1',
      text: 'The source reports a material technology update.',
      sourceUrls: [candidate.canonicalUrl],
    },
  ],
  uncertainties: [],
  sourceUrls: [candidate.canonicalUrl],
}

function articleClient(body: string): AiClient {
  return {
    async complete() {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                articles: [
                  {
                    language: 'en',
                    title: 'Validated article',
                    summary: 'Validated summary',
                    blocks: [
                      {
                        id: 'lead',
                        kind: 'lead',
                        markdown: body,
                        claimIds: ['claim-1'],
                        uncertaintyIds: [],
                        sourceUrls: [candidate.canonicalUrl],
                      },
                      {
                        id: 'impact',
                        kind: 'impact',
                        markdown: 'Supported impact.',
                        claimIds: [],
                        uncertaintyIds: [],
                        sourceUrls: [],
                      },
                    ],
                    sourceUrls: [candidate.canonicalUrl],
                  },
                ],
              }),
            },
          },
        ],
      }
    },
  }
}

describe('editorial output boundary', () => {
  it('uses one contract-repair request for malformed model JSON', async () => {
    const operations: string[] = []
    let repairSystem = ''
    const editorial = createEditorial(config, {
      async complete(request) {
        operations.push(request.operation)
        if (request.operation === 'gate') return { choices: [{ message: { content: '{"publish": true' } }] }
        repairSystem = request.system
        return {
          choices: [
            {
              message: {
                content: JSON.stringify(decision),
              },
            },
          ],
        }
      },
    })

    expect(await editorial.evaluate(candidate, [])).toEqual(decision)
    expect(operations).toEqual(['gate', 'repair'])
    expect(repairSystem).toContain('claims use text never claim')
    expect(repairSystem).toContain('sourceUrls is always an array never an object')
  })

  it('maps configured BCP 47 tags to explicit generation languages while preserving the tags', async () => {
    let systemPrompt = ''
    const requestedLanguages = [
      ['zh-CN', 'Simplified Chinese'],
      ['zh-TW', 'Traditional Chinese'],
      ['en', 'English'],
      ['ja', 'Japanese'],
      ['ko', 'Korean'],
      ['es', 'Spanish'],
      ['fr', 'French'],
      ['de', 'German'],
      ['pt-BR', 'Brazilian Portuguese'],
      ['it', 'Italian'],
      ['ru', 'Russian'],
      ['ar', 'Arabic'],
      ['hi', 'Hindi'],
      ['id', 'Indonesian'],
      ['tr', 'Turkish'],
      ['nl', 'Dutch'],
      ['pl', 'Polish'],
      ['vi', 'Vietnamese'],
      ['th', 'Thai'],
      ['ms', 'Malay'],
    ] as const
    const languages = requestedLanguages.map(([tag]) => tag)
    const editorial = createEditorial(
      { ...config, languages },
      {
        async complete(request) {
          systemPrompt = request.system
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    articles: languages.map((language) => ({
                      language,
                      title: `Title in ${language}`,
                      summary: `Summary in ${language}`,
                      blocks: [
                        {
                          id: 'lead',
                          kind: 'lead',
                          markdown: `Body in ${language}`,
                          claimIds: ['claim-1'],
                          uncertaintyIds: [],
                          sourceUrls: [candidate.canonicalUrl],
                        },
                        {
                          id: 'impact',
                          kind: 'impact',
                          markdown: 'Supported impact.',
                          claimIds: [],
                          uncertaintyIds: [],
                          sourceUrls: [],
                        },
                      ],
                      sourceUrls: [candidate.canonicalUrl],
                    })),
                  }),
                },
              },
            ],
          }
        },
      },
    )

    await editorial.generate(candidate, decision)

    for (const [tag, name] of requestedLanguages) expect(systemPrompt).toContain(`${tag} = ${name}`)
    expect(systemPrompt).toContain('Keep article.language as its original BCP 47 tag')
    expect(systemPrompt).toContain(
      'write naturally in that language rather than translating English phrasing literally',
    )
    expect(systemPrompt).toContain('no block may repeat it verbatim')
    expect(systemPrompt).toContain('Core renders body deterministically by joining block markdown')
    expect(systemPrompt).toContain(candidate.canonicalUrl)
  })

  it('repairs generation with exact root, article, and Story Block field names', async () => {
    const operations: string[] = []
    let repairSystem = ''
    const editorial = createEditorial(config, {
      async complete(request) {
        operations.push(request.operation)
        if (request.operation === 'generation')
          return { choices: [{ message: { content: '{"articles":[{"language":"en","storyBlocks":[]}]}' } }] }
        repairSystem = request.system
        return articleClient('Repaired source-backed body.').complete(request)
      },
    })

    expect(await editorial.generate(candidate, decision)).toHaveLength(1)
    expect(operations).toEqual(['generation', 'repair'])
    expect(repairSystem).toContain('the root has only articles')
    expect(repairSystem).toContain('uses blocks never storyBlocks')
    expect(repairSystem).toContain('uses kind never type or profile')
  })

  it('gives the publication gate recent approved coverage for semantic deduplication', async () => {
    let userPrompt = ''
    let systemPrompt = ''
    const editorial = createEditorial(config, {
      async complete(request) {
        systemPrompt = request.system
        userPrompt = request.user
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  publish: false,
                  score: 0.2,
                  reason: 'duplicate event',
                  topics: [],
                  risks: [],
                  claims: [],
                  uncertainties: [],
                  sourceUrls: [],
                }),
              },
            },
          ],
        }
      },
    })
    const recentPublications = [
      {
        decisionKey: 'decision-1',
        title: 'Previously approved coverage',
        canonicalUrl: 'https://source.example/previous',
        publishedAt: '2026-01-01T00:00:00.000Z',
      },
    ]

    await editorial.evaluate(candidate, recentPublications)

    expect(JSON.parse(userPrompt).recentPublications).toEqual(recentPublications)
    expect(systemPrompt).toContain('Each claims entry must contain exactly id, text, sourceUrls')
    expect(systemPrompt).toContain('use the field name text, never claim')
    expect(systemPrompt).toContain('When publish is false, claims and top-level sourceUrls must both be empty arrays')
  })

  it('rejects raw HTML from generated Markdown', () => {
    const editorial = createEditorial(config, articleClient('<img src=x onerror="alert(1)">'))
    expect(editorial.generate(candidate, decision)).rejects.toThrow('AI output contains raw HTML')
  })

  it('allows Markdown autolinks that are not HTML elements', async () => {
    const editorial = createEditorial(config, articleClient('Read <https://source.example/article> for details.'))
    expect(await editorial.generate(candidate, decision)).toHaveLength(1)
  })

  it('rejects a Story Block that repeats the standalone article summary', () => {
    const editorial = createEditorial(config, articleClient('Validated summary'))
    expect(editorial.generate(candidate, decision)).rejects.toThrow('repeats the standalone article summary')
  })

  it('requires fixed blocks while allowing evidence-dependent profile blocks to be omitted', async () => {
    const response = (blocks: readonly object[]): AiClient => ({
      async complete() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  articles: [
                    {
                      language: 'en',
                      title: 'Technology update',
                      summary: 'A material technology update.',
                      blocks,
                      sourceUrls: [candidate.canonicalUrl],
                    },
                  ],
                }),
              },
            },
          ],
        }
      },
    })
    const keyPoints = {
      id: 'key-points',
      kind: 'key-points',
      markdown: 'The source reports a material technology update.',
      claimIds: ['claim-1'],
      uncertaintyIds: [],
      sourceUrls: [candidate.canonicalUrl],
    }
    const impact = {
      id: 'impact',
      kind: 'impact',
      markdown: 'The update applies to the named product.',
      claimIds: [],
      uncertaintyIds: [],
      sourceUrls: [],
    }
    const productConfig = { ...config, profile: editorialProfiles['product-update'] }

    expect(
      await createEditorial(productConfig, response([keyPoints, impact])).generate(candidate, decision),
    ).toHaveLength(1)
    expect(createEditorial(productConfig, response([keyPoints])).generate(candidate, decision)).rejects.toThrow(
      'Story Blocks do not match',
    )
  })

  it('rejects Story Blocks whose claim references do not match their sources', async () => {
    const editorial = createEditorial(config, {
      async complete() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  articles: [
                    {
                      language: 'en',
                      title: 'Mapped article',
                      summary: 'Mapped summary',
                      blocks: [
                        {
                          id: 'lead',
                          kind: 'lead',
                          markdown: 'Lead.',
                          claimIds: ['claim-1'],
                          uncertaintyIds: [],
                          sourceUrls: [],
                        },
                        {
                          id: 'impact',
                          kind: 'impact',
                          markdown: 'Impact.',
                          claimIds: [],
                          uncertaintyIds: [],
                          sourceUrls: [],
                        },
                      ],
                      sourceUrls: [candidate.canonicalUrl],
                    },
                  ],
                }),
              },
            },
          ],
        }
      },
    })

    await expect(editorial.generate(candidate, decision)).rejects.toThrow(
      'Story Block source URLs do not match its evidence references',
    )
  })

  it('merges reports only through an exhaustive, non-overlapping consolidation result', async () => {
    const second: Candidate = {
      sourceId: 'source-2',
      externalId: 'entry-2',
      canonicalUrl: 'https://second.example.org/article',
      title: 'Second report of the same event',
      content: 'An independent report describes the same dated technology update.',
      contentOrigin: 'article-page',
    }
    const editorial = createEditorial(config, {
      async complete() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  groups: [{ reportIndexes: [0, 1], reason: 'The same actors and dated event' }],
                }),
              },
            },
          ],
        }
      },
    })

    const stories = await editorial.consolidate([candidate, second])

    expect(stories).toHaveLength(1)
    expect(stories[0]?.reports?.map((report) => report.canonicalUrl)).toEqual([
      candidate.canonicalUrl,
      second.canonicalUrl,
    ])
  })

  it('rejects consolidation that omits or duplicates a report index', async () => {
    const editorial = createEditorial(config, {
      async complete() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  groups: [{ reportIndexes: [0, 0], reason: 'Invalid duplicate index' }],
                }),
              },
            },
          ],
        }
      },
    })

    await expect(editorial.consolidate([candidate, { ...candidate, externalId: 'entry-2' }])).rejects.toThrow(
      'every report index exactly once',
    )
  })

  it('rejects gate evidence URLs that were not fetched for the merged story', async () => {
    const editorial = createEditorial(config, {
      async complete() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  publish: true,
                  score: 0.9,
                  reason: 'important',
                  topics: ['technology'],
                  risks: [],
                  claims: [
                    {
                      id: 'claim-1',
                      text: 'A claim from an unrelated source.',
                      sourceUrls: ['https://unknown.example/report'],
                    },
                  ],
                  uncertainties: [],
                  sourceUrls: ['https://unfetched.example.org/article'],
                }),
              },
            },
          ],
        }
      },
    })

    await expect(editorial.evaluate(candidate, [])).rejects.toThrow('unknown claim source URL')
  })

  it('does not accept a discovery summary as verified article evidence', async () => {
    const summary = { ...candidate, contentOrigin: 'source-summary' as const }
    const editorial = createEditorial(config, {
      async complete() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  publish: true,
                  score: 0.9,
                  reason: 'Claims are present only in a feed summary.',
                  topics: ['technology'],
                  risks: [],
                  claims: [
                    {
                      id: 'claim-1',
                      text: 'A discovery summary claim.',
                      sourceUrls: [summary.canonicalUrl],
                    },
                  ],
                  uncertainties: [],
                  sourceUrls: [summary.canonicalUrl],
                }),
              },
            },
          ],
        }
      },
    })

    await expect(editorial.evaluate(summary, [])).rejects.toThrow('unknown claim source URL')
  })
})
