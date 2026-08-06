import { describe, expect, it } from 'bun:test'
import { createEditorial } from '../src/adapters/editorial'
import type { AiClient } from '../src/adapters/openai'
import type { EditorialConfig } from '../src/config/model'
import type { Candidate, GateDecision } from '../src/domain/content'

const config: EditorialConfig = {
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
}

const decision: GateDecision = {
  publish: true,
  score: 0.9,
  reason: 'important',
  topics: ['technology'],
  risks: [],
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
                    body,
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
  it('gives the publication gate recent approved coverage for semantic deduplication', async () => {
    let userPrompt = ''
    const editorial = createEditorial(config, {
      async complete(request) {
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
  })

  it('rejects raw HTML from generated Markdown', () => {
    const editorial = createEditorial(config, articleClient('<img src=x onerror="alert(1)">'))
    expect(editorial.generate(candidate, decision)).rejects.toThrow('AI output contains raw HTML')
  })

  it('allows Markdown autolinks that are not HTML elements', async () => {
    const editorial = createEditorial(config, articleClient('Read <https://source.example/article> for details.'))
    expect(await editorial.generate(candidate, decision)).toHaveLength(1)
  })
})
