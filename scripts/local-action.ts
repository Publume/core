import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

type CommandOptions = { cwd?: string; stdout?: 'inherit' | 'pipe' | 'ignore'; stderr?: 'inherit' | 'pipe' | 'ignore' }

async function command(args: string[], options: CommandOptions = {}): Promise<number> {
  const child = Bun.spawn(args, {
    cwd: options.cwd,
    stdin: 'inherit',
    stdout: options.stdout ?? 'inherit',
    stderr: options.stderr ?? 'inherit',
  })
  const drains: Promise<string>[] = []
  if (options.stdout === 'pipe') drains.push(new Response(child.stdout).text())
  if (options.stderr === 'pipe') drains.push(new Response(child.stderr).text())
  const [exitCode] = await Promise.all([child.exited, ...drains])
  return exitCode
}

async function ensureDocker(): Promise<void> {
  if (!Bun.which('act')) throw new Error('act is required; install nektos/act first')
  if (!Bun.which('docker')) throw new Error('Docker is required by act; start Docker Desktop first')
  if ((await command(['docker', 'info'], { stdout: 'ignore', stderr: 'ignore' })) !== 0)
    throw new Error('Docker is not running; start Docker Desktop first')
}

async function main(): Promise<void> {
  const argumentsList = new Set(process.argv.slice(2))
  const preview = argumentsList.has('--preview')
  const bootstrap = argumentsList.has('--bootstrap') || process.argv.includes('--mode=bootstrap')
  const mode = bootstrap ? 'bootstrap' : 'run'
  await ensureDocker()

  const root = process.cwd()
  const repository = '.local/site.git'
  const repositoryPath = path.resolve(root, repository)
  await mkdir(path.dirname(repositoryPath), { recursive: true })
  if (
    (await command(['git', 'rev-parse', '--is-bare-repository'], {
      cwd: repositoryPath,
      stdout: 'pipe',
      stderr: 'pipe',
    })) !== 0
  ) {
    const initialized = await command(['git', 'init', '--bare', repositoryPath])
    if (initialized !== 0) throw new Error('Unable to initialize .local/site.git')
  }

  const apiKey = process.env.AI_API_KEY || ''
  if (!apiKey) throw new Error('AI_API_KEY is missing; copy .env.example to .env and configure it first')
  for (const name of ['AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL', 'SOURCE_URLS', 'CONTENT_INSTRUCTIONS']) {
    if (!process.env[name]) throw new Error(`${name} is missing from .env`)
  }
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'publume-act-'))
  const secretsPath = path.join(temporaryDirectory, 'secrets')
  const emptyEnvPath = path.join(temporaryDirectory, 'env')
  await Bun.write(secretsPath, `AI_API_KEY=${apiKey}\nTARGET_REPO_TOKEN=${process.env.TARGET_REPO_TOKEN || ''}\n`)
  await chmod(secretsPath, 0o600)
  await Bun.write(emptyEnvPath, '')

  const variables: Array<[string, string]> = [
    ['AI_PROVIDER', process.env.AI_PROVIDER || ''],
    ['AI_BASE_URL', process.env.AI_BASE_URL || ''],
    ['AI_MODEL', process.env.AI_MODEL || ''],
    ['AI_ALLOWED_MODELS', process.env.AI_ALLOWED_MODELS || process.env.AI_MODEL || ''],
    ['AI_RESPONSE_FORMAT', process.env.AI_RESPONSE_FORMAT || 'json_object'],
    ['AI_TIMEOUT_SECONDS', process.env.AI_TIMEOUT_SECONDS || '60'],
    ['TARGET_REPOSITORY', repository],
    ['SOURCE_URLS', process.env.SOURCE_URLS || ''],
    ['CONTENT_INSTRUCTIONS', process.env.CONTENT_INSTRUCTIONS || ''],
    ['GATE_PROMPT', process.env.GATE_PROMPT || ''],
    ['ARTICLE_PROMPT', process.env.ARTICLE_PROMPT || ''],
    ['OUTPUT_LANGUAGES', process.env.OUTPUT_LANGUAGES || 'en'],
    [
      'DEFAULT_CONTENT_LANGUAGE',
      process.env.DEFAULT_CONTENT_LANGUAGE || process.env.OUTPUT_LANGUAGES?.split(/[\n,]/)[0]?.trim() || 'en',
    ],
    ['PUBLISH_THRESHOLD', process.env.PUBLISH_THRESHOLD || '0.75'],
    ['DEDUPLICATION_CONTEXT_SIZE', process.env.DEDUPLICATION_CONTEXT_SIZE || '50'],
    ['TARGET_BRANCH', process.env.TARGET_BRANCH || 'main'],
    ['MAX_ITEM_AGE_HOURS', process.env.MAX_ITEM_AGE_HOURS || '24'],
    ['MAX_CANDIDATES_PER_RUN', process.env.MAX_CANDIDATES_PER_RUN || '20'],
    ['MAX_DECISION_RECORDS', process.env.MAX_DECISION_RECORDS || '1000'],
    ['MINIMUM_CONTENT_LENGTH', process.env.MINIMUM_CONTENT_LENGTH || '80'],
    ['SOURCE_TIMEOUT_SECONDS', process.env.SOURCE_TIMEOUT_SECONDS || '20'],
    ['STATE_PATH', process.env.STATE_PATH || 'state/decisions.json'],
    ['THEME_REPOSITORY', process.env.THEME_REPOSITORY || 'Publume/themes'],
    ['THEME_REF', process.env.THEME_REF || 'main'],
    ['THEME', process.env.THEME || 'editorial'],
    ['SITE_URL', process.env.SITE_URL || ''],
    ['SITE_NAME', process.env.SITE_NAME || 'Publume Site'],
    ['SITE_DESCRIPTION', process.env.SITE_DESCRIPTION || ''],
    ['SITE_TAGLINE', process.env.SITE_TAGLINE || ''],
    [
      'SITE_LOCALE',
      process.env.SITE_LOCALE ||
        process.env.DEFAULT_CONTENT_LANGUAGE ||
        process.env.OUTPUT_LANGUAGES?.split(/[\n,]/)[0]?.trim() ||
        'en',
    ],
    ['SITE_PUBLISHER_NAME', process.env.SITE_PUBLISHER_NAME || process.env.SITE_NAME || 'Publume Site'],
    ['SITE_AUTHOR_NAME', process.env.SITE_AUTHOR_NAME || process.env.SITE_NAME || 'Editorial Desk'],
    ['SITE_CONTACT_URL', process.env.SITE_CONTACT_URL || ''],
    ['SITE_AI_DISCLOSURE', process.env.SITE_AI_DISCLOSURE || ''],
    ['SITE_SOCIAL_IMAGE_URL', process.env.SITE_SOCIAL_IMAGE_URL || ''],
    ['SITE_NEWSLETTER_URL', process.env.SITE_NEWSLETTER_URL || ''],
    ['SITE_SPONSOR_URL', process.env.SITE_SPONSOR_URL || ''],
    ['SITE_THEME', process.env.SITE_THEME || 'default'],
    ['SITE_PRIMARY_COLOR', process.env.SITE_PRIMARY_COLOR || '#2563eb'],
    ['SITE_ACCENT_COLOR', process.env.SITE_ACCENT_COLOR || '#0891b2'],
    ['SITE_BACKGROUND_COLOR', process.env.SITE_BACKGROUND_COLOR || '#ffffff'],
    ['SITE_SURFACE_COLOR', process.env.SITE_SURFACE_COLOR || '#f8fafc'],
    ['SITE_TEXT_COLOR', process.env.SITE_TEXT_COLOR || '#0f172a'],
    ['SITE_MUTED_COLOR', process.env.SITE_MUTED_COLOR || '#64748b'],
    ['SITE_MAX_WIDTH', process.env.SITE_MAX_WIDTH || '1180px'],
    ['SITE_CARD_RADIUS', process.env.SITE_CARD_RADIUS || '16px'],
    ['SITE_SHOW_TOPICS', process.env.SITE_SHOW_TOPICS || 'true'],
    ['SITE_SHOW_SCORE', process.env.SITE_SHOW_SCORE || 'false'],
    ['SITE_SHOW_SOURCES', process.env.SITE_SHOW_SOURCES || 'true'],
    ['SITE_FOOTER_TEXT', process.env.SITE_FOOTER_TEXT || ''],
    ['PUBLUME_LOCAL', 'true'],
  ]
  const actArguments = [
    'workflow_dispatch',
    '--workflows',
    '.github/workflows/generate.yml',
    '--bind',
    '--secret-file',
    secretsPath,
    '--env-file',
    emptyEnvPath,
    '--rm',
  ]
  actArguments.push('--input', `mode=${mode}`)
  for (const [key, value] of variables) actArguments.push('--var', `${key}=${value}`)

  try {
    const exitCode = await command(['act', ...actArguments])
    if (exitCode !== 0) throw new Error(`Local GitHub Actions run failed with exit code ${exitCode}`)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }

  console.log(`Local site repository: ${repositoryPath}`)
  if (!preview) return
  const sitePath = path.resolve(root, '.local/site')
  if ((await command(['git', 'clone', repositoryPath, sitePath], { stdout: 'inherit', stderr: 'inherit' })) !== 0) {
    await command(['git', '-C', sitePath, 'fetch', 'origin', 'main'])
    await command(['git', '-C', sitePath, 'checkout', '-B', 'main', 'origin/main'])
  }
  if ((await command(['bun', 'install', '--frozen-lockfile'], { cwd: sitePath })) !== 0)
    throw new Error('Site dependency installation failed')
  console.log('Starting the theme preview command...')
  const server = Bun.spawn(['bun', 'run', 'dev'], {
    cwd: sitePath,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await server.exited
}

if (import.meta.main) await main()
