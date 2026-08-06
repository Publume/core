import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { SitePublisher } from '../app/ports'
import type { AppConfig } from '../config/model'
import { git, repositoryUrl, runCommand, targetGitEnvironment } from './git'
import { readPublishedDecisionKeys, writeSiteContent } from './site-content'

const themeMarker = z.object({ schemaVersion: z.literal(1), id: z.string().min(1) }).strict()
const siteMarker = z.object({ schemaVersion: z.literal(1), theme: z.string().min(1) }).strict()

type Checkout = { readonly directory: string; cleanup(): Promise<void> }

async function cloneTarget(config: AppConfig): Promise<Checkout> {
  const directory = await mkdtemp(path.join(tmpdir(), 'publume-site-'))
  const result = await runCommand(
    ['git', 'clone', repositoryUrl(config.target.repository), directory],
    process.cwd(),
    targetGitEnvironment(config.target),
  )
  if (result.code !== 0) {
    await rm(directory, { recursive: true, force: true })
    throw new Error(`Target clone failed: ${result.stderr.trim()}`)
  }
  const remoteBranch = `refs/remotes/origin/${config.target.branch}`
  const branchLookup = await runCommand(['git', 'show-ref', '--verify', '--quiet', remoteBranch], directory)
  if (branchLookup.code === 0) await git(['checkout', '-B', config.target.branch, remoteBranch], directory)
  else if (branchLookup.code === 1) await git(['checkout', '-B', config.target.branch], directory)
  else throw new Error(`Target branch lookup failed: ${branchLookup.stderr.trim()}`)
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

async function checkoutTheme(config: AppConfig): Promise<Checkout> {
  const directory = await mkdtemp(path.join(tmpdir(), 'publume-theme-'))
  try {
    await git(['init'], directory)
    await git(['remote', 'add', 'origin', repositoryUrl(config.theme.repository)], directory)
    await git(['fetch', '--depth', '1', 'origin', config.theme.ref], directory)
    await git(['checkout', '--detach', 'FETCH_HEAD'], directory)
    return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function targetIsEmpty(directory: string): Promise<boolean> {
  return (await readdir(directory)).every((entry) => entry === '.git')
}

async function bootstrapTheme(config: AppConfig, targetDirectory: string): Promise<void> {
  const checkout = await checkoutTheme(config)
  try {
    const sharedDirectory = path.join(checkout.directory, 'shared')
    const themeDirectory = path.join(checkout.directory, 'themes', config.theme.id)
    const marker = themeMarker.parse(
      JSON.parse(await readFile(path.join(themeDirectory, '.publume-theme.json'), 'utf8')),
    )
    if (marker.id !== config.theme.id)
      throw new Error(`Theme marker identifies ${marker.id}, expected ${config.theme.id}`)

    const ignored = new Set(['.astro', '.git', 'dist', 'node_modules'])
    const copyPart = async (directory: string) =>
      cp(directory, targetDirectory, {
        recursive: true,
        force: true,
        filter: (source) => {
          const relativePath = path.relative(directory, source)
          return (
            relativePath !== '.publume-theme.json' && !relativePath.split(path.sep).some((part) => ignored.has(part))
          )
        },
      })
    await copyPart(sharedDirectory)
    await copyPart(themeDirectory)
    const articleDirectory = path.join(targetDirectory, 'src/content/articles')
    // Theme examples are useful in the source repository, but generated content is owned exclusively by Core.
    await rm(articleDirectory, { recursive: true, force: true })
    await mkdir(articleDirectory, { recursive: true })
    await writeFile(path.join(articleDirectory, '.gitkeep'), '')
    await writeFile(
      path.join(targetDirectory, '.publume-site.json'),
      `${JSON.stringify({ schemaVersion: 1, theme: config.theme.id }, null, 2)}\n`,
    )
  } finally {
    await checkout.cleanup()
  }
}

async function replaceTheme(config: AppConfig, targetDirectory: string): Promise<void> {
  const preservedDirectory = await mkdtemp(path.join(tmpdir(), 'publume-content-'))
  const articles = path.join(targetDirectory, 'src/content/articles')
  const preservedArticles = path.join(preservedDirectory, 'articles')
  try {
    await cp(articles, preservedArticles, { recursive: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    for (const entry of await readdir(targetDirectory)) {
      if (entry !== '.git') await rm(path.join(targetDirectory, entry), { recursive: true, force: true })
    }
    await bootstrapTheme(config, targetDirectory)
    await cp(preservedArticles, articles, { recursive: true, force: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  } finally {
    await rm(preservedDirectory, { recursive: true, force: true })
  }
}

async function ensureTheme(config: AppConfig, targetDirectory: string, allowReplacement: boolean): Promise<boolean> {
  if (await targetIsEmpty(targetDirectory)) {
    await bootstrapTheme(config, targetDirectory)
    return true
  }

  let marker: z.infer<typeof siteMarker>
  try {
    marker = siteMarker.parse(JSON.parse(await readFile(path.join(targetDirectory, '.publume-site.json'), 'utf8')))
  } catch (error) {
    // A marker is the ownership proof required before Core writes into a non-empty repository.
    throw new Error('Target repository is non-empty and has no compatible .publume-site.json', { cause: error })
  }
  if (marker.theme !== config.theme.id) {
    if (!allowReplacement) throw new Error(`Target site uses theme ${marker.theme}, expected ${config.theme.id}`)
    await replaceTheme(config, targetDirectory)
    return true
  }
  return false
}

async function buildSite(directory: string): Promise<void> {
  const excludedVariables = new Set(['DELIVERY_CONFIG'])
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        value !== undefined && !excludedVariables.has(name) && !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name),
    ),
  ) as Record<string, string>
  // Theme scripts are trusted code, but common secret-shaped variables are still withheld as defense in depth.
  const install = await runCommand(['bun', 'install', '--frozen-lockfile'], directory, environment, false)
  if (install.code !== 0) throw new Error(`Site dependency installation failed: ${install.stderr.trim()}`)
  const build = await runCommand(['bun', 'run', 'build'], directory, environment, false)
  if (build.code !== 0) throw new Error(`Site build failed: ${build.stderr.trim()}`)
}

export function createSitePublisher(config: AppConfig): SitePublisher {
  return {
    async publishedDecisionKeys(): Promise<ReadonlySet<string>> {
      const target = await cloneTarget(config)
      try {
        return await readPublishedDecisionKeys(target.directory)
      } finally {
        await target.cleanup()
      }
    },

    async publish(articles, mode): Promise<string | undefined> {
      const target = await cloneTarget(config)
      try {
        const bootstrapped = await ensureTheme(config, target.directory, mode === 'bootstrap')
        await writeSiteContent(config.site, target.directory, mode === 'bootstrap' ? [] : articles)
        await buildSite(target.directory)
        await git(['config', 'user.name', 'publume[bot]'], target.directory)
        await git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], target.directory)

        const paths =
          mode === 'bootstrap' || bootstrapped ? ['.'] : ['src/content/articles', 'src/data/site-config.generated.json']
        if (mode === 'content') {
          const generated = await readdir(path.join(target.directory, 'public/generated')).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw error
          })
          if (generated) paths.push('public/generated')
        }
        await git(['add', ...paths], target.directory)
        if (!(await git(['diff', '--cached', '--name-only'], target.directory))) return undefined

        const message = mode === 'bootstrap' ? 'chore: bootstrap site' : 'content: publish validated articles'
        await git(['commit', '-m', message], target.directory)
        await git(
          ['push', 'origin', `HEAD:${config.target.branch}`],
          target.directory,
          targetGitEnvironment(config.target),
        )
        return await git(['rev-parse', 'HEAD'], target.directory)
      } finally {
        await target.cleanup()
      }
    },
  }
}
