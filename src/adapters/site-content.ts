import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SiteConfig } from '../config/model'
import type { Article } from '../domain/content'
import { topicIdForLabel } from '../domain/topics'

function articleMarkdown(article: Article): string {
  const topicLabels = article.topics ?? []
  const topics = topicLabels.map((topic) => `  - ${JSON.stringify(topic)}`).join('\n')
  const topicIds = (article.topicIds ?? topicLabels.map(topicIdForLabel))
    .map((topicId) => `  - ${JSON.stringify(topicId)}`)
    .join('\n')
  const sources = article.sourceUrls.map((url) => `  - ${JSON.stringify(url)}`).join('\n')
  return [
    '---',
    `decisionKey: ${JSON.stringify(article.decisionKey)}`,
    `language: ${JSON.stringify(article.language)}`,
    `title: ${JSON.stringify(article.title)}`,
    `summary: ${JSON.stringify(article.summary)}`,
    `publishedAt: ${JSON.stringify(article.publishedAt)}`,
    ...(article.score === undefined ? [] : [`score: ${article.score}`]),
    'topics:',
    topics || '  []',
    'topicIds:',
    topicIds || '  []',
    'sourceUrls:',
    sources,
    '---',
    '',
    article.body.trim(),
    '',
  ].join('\n')
}

function articleSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'article'
  )
}

export async function writeSiteContent(
  site: SiteConfig,
  directory: string,
  articles: readonly Article[],
): Promise<void> {
  const siteConfigPath = path.join(directory, 'src/data/site-config.generated.json')
  await mkdir(path.dirname(siteConfigPath), { recursive: true })
  await writeFile(siteConfigPath, `${JSON.stringify(site, null, 2)}\n`)

  for (const article of articles) {
    const articlePath = path.join(
      directory,
      'src/content/articles',
      article.language,
      `${articleSlug(article.title)}-${article.decisionKey.slice(0, 10)}.md`,
    )
    await mkdir(path.dirname(articlePath), { recursive: true })
    await writeFile(articlePath, articleMarkdown(article))
  }
}

export async function readPublishedDecisionKeys(directory: string): Promise<ReadonlySet<string>> {
  const keys = new Set<string>()
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    for (const entry of entries ?? []) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(entryPath)
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const value = (await readFile(entryPath, 'utf8')).match(/^decisionKey:\s*(.+?)\s*$/m)?.[1]
      if (!value) continue
      try {
        const parsed: unknown = value.startsWith('"') ? JSON.parse(value) : value
        if (typeof parsed === 'string' && parsed) keys.add(parsed)
      } catch {
        // Invalid user-owned Markdown is ignored; it cannot prove that a decision was published.
      }
    }
  }
  await visit(path.join(directory, 'src/content/articles'))
  return keys
}
