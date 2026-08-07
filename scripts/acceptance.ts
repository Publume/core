import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEditorial } from '../src/adapters/editorial'
import { createFileDecisionStore } from '../src/adapters/file-decisions'
import type { AiClient } from '../src/adapters/openai'
import { createSitePublisher } from '../src/adapters/site-publisher'
import { createSourceReader, type FetchLike } from '../src/adapters/sources/reader'
import { runPipeline } from '../src/app/pipeline'
import type { PipelinePorts } from '../src/app/ports'
import { loadConfig } from '../src/config/load'
import type { AppConfig } from '../src/config/model'
import { createThemeRepository } from '../tests/support/theme'

async function command(args: readonly string[], cwd: string): Promise<string> {
  const child = Bun.spawn([...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${args.join(' ')} failed:\n${[stdout, stderr].filter(Boolean).join('\n').trim()}`)
  return stdout.trim()
}

async function snapshotThemeRepository(source: string, root: string): Promise<string> {
  const repository = path.join(root, 'themes-under-test')
  const ignored = new Set(['.astro', '.contract', '.git', 'dist', 'node_modules'])
  await cp(source, repository, {
    recursive: true,
    filter: (entry) =>
      !path
        .relative(source, entry)
        .split(path.sep)
        .some((part) => ignored.has(part)),
  })
  await command(['git', 'init', '-b', 'main'], repository)
  await command(['git', 'config', 'user.name', 'fixture'], repository)
  await command(['git', 'config', 'user.email', 'fixture@example.test'], repository)
  await command(['git', 'add', '.'], repository)
  await command(['git', 'commit', '-m', 'test: snapshot theme'], repository)
  return repository
}

async function addAlternateTheme(repository: string, themeId: string): Promise<string> {
  const alternateId = `${themeId}-alternate`
  const source = path.join(repository, 'themes', themeId)
  const destination = path.join(repository, 'themes', alternateId)
  await cp(source, destination, { recursive: true })
  await writeFile(
    path.join(destination, '.publume-theme.json'),
    `${JSON.stringify({ schemaVersion: 1, id: alternateId })}\n`,
  )
  await writeFile(path.join(destination, 'alternate-theme.txt'), 'alternate theme\n')
  await command(['git', 'add', '.'], repository)
  await command(['git', 'commit', '-m', 'test: add alternate theme'], repository)
  return alternateId
}

function createPorts(config: AppConfig, fetchFn: FetchLike, aiClient: AiClient): PipelinePorts {
  return {
    sources: createSourceReader(config.sources.entries, config.sources.timeoutMs, fetchFn),
    editorial: createEditorial(config.editorial, aiClient),
    decisions: createFileDecisionStore(config.state.path),
    delivery: [],
    site: createSitePublisher(config),
  }
}

const root = await mkdtemp(path.join(tmpdir(), 'publume-acceptance-'))
const outputArgument = process.argv.find((argument) => argument.startsWith('--output='))
const outputDirectory = outputArgument ? path.resolve(outputArgument.slice('--output='.length)) : undefined
const previousDeliveryConfig = process.env.DELIVERY_CONFIG
process.env.PUBLUME_ACCEPTANCE_SECRET = 'must-not-reach-theme-build'
process.env.DELIVERY_CONFIG = 'must-not-reach-theme-build'

try {
  const targetRepository = path.join(root, 'site.git')
  const themeSource = process.env.PUBLUME_THEME_DIRECTORY
  const themeRepository = themeSource
    ? await snapshotThemeRepository(path.resolve(themeSource), root)
    : await createThemeRepository(root, command)
  const themeId = themeSource ? (process.env.PUBLUME_THEME_ID ?? 'editorial') : 'fixture'
  const alternateThemeId = await addAlternateTheme(themeRepository, themeId)
  // Keep the bare repository HEAD different from the configured publishing branch.
  await command(['git', 'init', '--bare', '--initial-branch', 'unrelated-default', targetRepository], root)

  const fetchFixture: FetchLike = async (input) => {
    const url = String(input)
    if (url.endsWith('/feed.xml'))
      return new Response(
        '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>rss-1</guid><title>RSS signal</title><link>https://example.test/rss-1</link><description>A reliable RSS signal with enough context for an important publication.</description></item></channel></rss>',
        { headers: { 'content-type': 'application/rss+xml' } },
      )
    if (url.endsWith('/items.json'))
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'json-1',
              title: 'JSON signal',
              content: 'A reliable JSON signal with enough context for an important publication.',
              url: 'https://example.test/json-1',
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    if (url.endsWith('/rss-1'))
      return new Response(
        '<article><h1>Shared release reaches production</h1><p>The production release introduces the same material capability described by the JSON report, with complete article evidence.</p></article>',
        { headers: { 'content-type': 'text/html' } },
      )
    if (url.endsWith('/json-1'))
      return new Response(
        '<article><h1>Shared release reaches production</h1><p>An independent report confirms the production release and adds source-bounded implementation details.</p></article>',
        { headers: { 'content-type': 'text/html' } },
      )
    if (url.endsWith('/page.html'))
      return new Response(
        '<article><h1>HTML signal</h1><p>A reliable HTML signal with enough context for an important publication.</p></article>',
        { headers: { 'content-type': 'text/html' } },
      )
    throw new Error(`fixture unavailable: ${url}`)
  }

  const calls = { count: 0 }
  const aiCallCount = (): number => calls.count
  const aiClient: AiClient = {
    async complete(request) {
      calls.count += 1
      const user = JSON.parse(request.user) as {
        story?: { reports?: { canonicalUrl: string; content: string }[] }
        gate?: { sourceUrls?: string[] }
        languages?: string[]
        reports?: unknown[]
        task?: string
      }
      if (user.reports)
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  groups: [
                    { reportIndexes: [0, 1], reason: 'Two reports describe the same production release' },
                    { reportIndexes: [2], reason: 'A distinct HTML report' },
                  ],
                }),
              },
            },
          ],
        }
      if (user.task)
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  publish: true,
                  score: 0.95,
                  reason: 'important and sourced',
                  topics: ['technology'],
                  risks: [],
                  verifiedFacts: user.story?.reports?.map((report) => report.content) ?? [
                    'Source-backed fixture fact.',
                  ],
                  uncertainties: [],
                  sourceUrls: user.story?.reports?.map((report) => report.canonicalUrl) ?? [],
                }),
              },
            },
          ],
        }
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                articles: (user.languages ?? ['en']).map((language) => ({
                  language,
                  title: `Validated ${language}`,
                  summary: 'Validated summary',
                  body: 'Validated body with source-backed facts.',
                  sourceUrls: user.gate?.sourceUrls ?? [],
                })),
              }),
            },
          },
        ],
      }
    },
  }

  const config = loadConfig(
    {
      AI_PROVIDER: 'openai-compatible',
      AI_API_KEY: 'fake-key',
      AI_BASE_URL: 'https://api.example.test/v1',
      AI_MODEL: 'test-model',
      TARGET_REPOSITORY: targetRepository,
      SITE_URL: 'https://example.test/publication/',
      SOURCE_URLS:
        'https://example.test/feed.xml\nhttps://example.test/items.json\nhttps://example.test/page.html\nhttps://example.test/unavailable',
      CONTENT_INSTRUCTIONS: 'Publish important, verifiable updates for the configured audience.',
      OUTPUT_LANGUAGES: 'en,fr',
      DEFAULT_CONTENT_LANGUAGE: 'fr',
      SITE_LOCALE: 'zh-CN',
      PUBLISH_THRESHOLD: '0.75',
      MINIMUM_CONTENT_LENGTH: '40',
      THEME_REPOSITORY: themeRepository,
      THEME_REF: 'main',
      THEME: themeId,
    },
    { rootDir: root },
  )

  const first = await runPipeline(config, createPorts(config, fetchFixture, aiClient), {
    mode: 'initial',
    allowTestSources: true,
  })
  if (
    first.published !== 4 ||
    first.sourceErrors !== 1 ||
    first.evidenceFetched !== 2 ||
    first.evidenceErrors !== 0 ||
    first.storyGroups !== 2 ||
    first.reportsMerged !== 1 ||
    aiCallCount() !== 5
  )
    throw new Error(
      `first run did not fetch evidence, merge reports, and publish 4 language files: ${JSON.stringify({ first, calls: calls.count })}`,
    )

  const stateAfterFirst = JSON.parse(await readFile(config.state.path, 'utf8')) as {
    decisions: Record<string, { status: string }>
  }
  if (Object.values(stateAfterFirst.decisions).some((decision) => decision.status !== 'published'))
    throw new Error('first run did not persist published decisions')

  const secondConfig = { ...config, state: { ...config.state, path: path.join(root, 'second-run-state.json') } }
  const second = await runPipeline(secondConfig, createPorts(secondConfig, fetchFixture, aiClient), {
    allowTestSources: true,
  })
  if (second.published !== 0 || aiCallCount() !== 6)
    throw new Error(`second run was not idempotent: ${JSON.stringify({ second, calls: calls.count })}`)

  const checkout = path.join(root, 'checkout')
  await command(['git', 'clone', '--branch', config.target.branch, targetRepository, checkout], root)
  const files = (await command(['git', 'ls-tree', '-r', '--name-only', 'HEAD'], checkout)).split('\n')
  const articleCount = files.filter((file) => file.startsWith('src/content/articles/') && file.endsWith('.md')).length
  if (articleCount !== 4) throw new Error(`expected 4 article files, found ${articleCount}`)
  const generatedArticles = files.filter((file) => file.startsWith('src/content/articles/') && file.endsWith('.md'))
  const mergedArticle = await Promise.all(
    generatedArticles.map((file) => readFile(path.join(checkout, file), 'utf8')),
  ).then((articles) => articles.find((article) => article.includes('/rss-1') && article.includes('/json-1')))
  if (!mergedArticle) throw new Error('published output did not preserve the merged story source set')
  for (const requiredFile of [
    '.github/workflows/pages.yml',
    '.publume-site.json',
    'package.json',
    'src/data/site-config.generated.json',
  ]) {
    if (!files.includes(requiredFile)) throw new Error(`initial deployment missing ${requiredFile}`)
  }
  if (files.includes('.publume-theme.json')) throw new Error('source theme marker leaked into target repository')
  const marker = JSON.parse(await readFile(path.join(checkout, '.publume-site.json'), 'utf8')) as {
    schemaVersion?: number
    theme?: string
  }
  if (marker.schemaVersion !== 1 || marker.theme !== themeId) throw new Error('Publume site marker is invalid')

  if (themeSource) {
    await command(['bun', 'install', '--frozen-lockfile'], checkout)
    await command(['bun', 'run', 'check'], checkout)
    const indexHtml = await readFile(path.join(checkout, 'dist/index.html'), 'utf8')
    if (!indexHtml.includes('https://example.test/publication/'))
      throw new Error('real theme output is missing the configured canonical site URL')
    if (!indexHtml.includes('/publication/rss.xml'))
      throw new Error('real theme output does not preserve the configured repository base path')
    if (!indexHtml.includes('Validated fr') || indexHtml.includes('Validated en'))
      throw new Error('default language index mixes article languages')
    for (const localizedText of ['Publume 内容站', '最新内容', '主导航', '只保留真正重要的信号。']) {
      if (!indexHtml.includes(localizedText))
        throw new Error(`site interface is missing localized text: ${localizedText}`)
    }
    const englishIndex = await readFile(path.join(checkout, 'dist/en/index.html'), 'utf8')
    if (!englishIndex.includes('Validated en') || englishIndex.includes('Validated fr'))
      throw new Error('secondary language index mixes article languages')
    if (!englishIndex.includes('最新内容'))
      throw new Error('secondary content index did not preserve the configured interface locale')
    if (!indexHtml.includes('hreflang="en"') || !indexHtml.includes('hreflang="fr"'))
      throw new Error('multilingual index is missing alternate-language metadata')
    for (const output of ['rss.xml', 'sitemap-index.xml']) {
      if (!(await Bun.file(path.join(checkout, 'dist', output)).exists()))
        throw new Error(`real theme output is missing ${output}`)
    }
    const articleFile = files.find((file) => file.startsWith('src/content/articles/') && file.endsWith('.md'))
    if (!articleFile) throw new Error('real theme output has no article to inspect')
    const articleOutput = articleFile.replace('src/content/articles/', 'dist/').replace(/\.md$/, '/index.html')
    const articleMarkdown = await readFile(path.join(checkout, articleFile), 'utf8')
    const articleHtml = await readFile(path.join(checkout, articleOutput), 'utf8')
    const sourceLiteral = articleMarkdown.match(/^\s+-\s+("https?:\/\/[^\n]+")\s*$/m)?.[1]
    const sourceUrl = sourceLiteral ? (JSON.parse(sourceLiteral) as unknown) : undefined
    if (typeof sourceUrl !== 'string' || !articleHtml.includes(sourceUrl))
      throw new Error('real theme article is missing its source link')
    if (!articleMarkdown.includes('topicIds:') || !articleMarkdown.includes('technology-'))
      throw new Error('published article is missing stable topic identities')
    for (const localizedText of ['来源', '编辑说明', '自动化系统协助筛选与起草']) {
      if (!articleHtml.includes(localizedText))
        throw new Error(`real theme article is missing localized text: ${localizedText}`)
    }
    if (outputDirectory) {
      if (existsSync(outputDirectory)) throw new Error(`acceptance output already exists: ${outputDirectory}`)
      await cp(checkout, outputDirectory, {
        recursive: true,
        filter: (entry) => !['.git', 'node_modules'].includes(path.basename(entry)),
      })
    }
  }

  await command(['git', 'config', 'user.name', 'fixture'], checkout)
  await command(['git', 'config', 'user.email', 'fixture@example.test'], checkout)
  await writeFile(path.join(checkout, 'obsolete-theme-file.txt'), 'old theme file\n')
  await command(['git', 'add', 'obsolete-theme-file.txt'], checkout)
  await command(['git', 'commit', '-m', 'test: add obsolete theme file'], checkout)
  await command(['git', 'push'], checkout)
  await createSitePublisher({ ...config, theme: { ...config.theme, id: alternateThemeId } }).publish([], 'bootstrap')

  const changedCheckout = path.join(root, 'changed-checkout')
  await command(['git', 'clone', '--branch', config.target.branch, targetRepository, changedCheckout], root)
  const changedFiles = (await command(['git', 'ls-tree', '-r', '--name-only', 'HEAD'], changedCheckout)).split('\n')
  const changedArticles = changedFiles.filter(
    (file) => file.startsWith('src/content/articles/') && file.endsWith('.md'),
  )
  if (changedArticles.length !== articleCount) throw new Error('theme replacement did not preserve published articles')
  if (changedFiles.includes('obsolete-theme-file.txt'))
    throw new Error('theme replacement retained obsolete theme files')
  if (!changedFiles.includes('alternate-theme.txt')) throw new Error('theme replacement did not install the new theme')
  const changedMarker = JSON.parse(await readFile(path.join(changedCheckout, '.publume-site.json'), 'utf8')) as {
    theme?: string
  }
  if (changedMarker.theme !== alternateThemeId) throw new Error('theme replacement did not update the site marker')

  const unknownRepository = path.join(root, 'unknown.git')
  const unknownWork = path.join(root, 'unknown-work')
  await command(['git', 'init', '--bare', unknownRepository], root)
  await command(['git', 'clone', unknownRepository, unknownWork], root)
  await writeFile(path.join(unknownWork, 'README.md'), 'user-owned content\n', 'utf8')
  await command(['git', 'config', 'user.name', 'fixture'], unknownWork)
  await command(['git', 'config', 'user.email', 'fixture@example.test'], unknownWork)
  await command(['git', 'add', 'README.md'], unknownWork)
  await command(['git', 'commit', '-m', 'fixture'], unknownWork)
  await command(['git', 'push', 'origin', 'HEAD:main'], unknownWork)
  let unknownRepositoryError = ''
  try {
    const unknownConfig = {
      ...config,
      target: { ...config.target, repository: unknownRepository },
    }
    await createSitePublisher(unknownConfig).publish([], 'bootstrap')
  } catch (error) {
    unknownRepositoryError = error instanceof Error ? error.message : String(error)
  }
  if (!unknownRepositoryError.includes('non-empty')) throw new Error('non-empty unknown target was not rejected')

  console.log(
    JSON.stringify({
      first,
      second,
      aiCalls: calls.count,
      articleFiles: articleCount,
      theme: alternateThemeId,
      ...(outputDirectory ? { outputDirectory } : {}),
    }),
  )
} finally {
  delete process.env.PUBLUME_ACCEPTANCE_SECRET
  if (previousDeliveryConfig === undefined) delete process.env.DELIVERY_CONFIG
  else process.env.DELIVERY_CONFIG = previousDeliveryConfig
  await rm(root, { recursive: true, force: true })
}
