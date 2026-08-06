import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

type RunCommand = (args: readonly string[], cwd: string) => Promise<string>

const buildScript = `import { mkdir, writeFile } from 'node:fs/promises'

if (process.env.PUBLUME_ACCEPTANCE_SECRET) throw new Error('secret leaked into theme build')
if (process.env.DELIVERY_CONFIG) throw new Error('delivery credentials leaked into theme build')
if (!(await Bun.file('src/data/site-config.generated.json').exists())) throw new Error('site config missing')
await mkdir('dist', { recursive: true })
await writeFile('dist/index.html', '<!doctype html><title>fixture</title>')
`

export async function createThemeRepository(root: string, run: RunCommand): Promise<string> {
  const repository = path.join(root, 'themes')
  const shared = path.join(repository, 'shared')
  const theme = path.join(repository, 'themes', 'fixture')
  await mkdir(path.join(shared, '.github/workflows'), { recursive: true })
  await mkdir(path.join(shared, 'src/data'), { recursive: true })
  await mkdir(path.join(shared, 'src/content/articles'), { recursive: true })
  await mkdir(path.join(theme, 'src/theme'), { recursive: true })
  await writeFile(path.join(theme, '.publume-theme.json'), '{"schemaVersion":1,"id":"fixture"}\n')
  await writeFile(path.join(shared, 'package.json'), '{"scripts":{"build":"bun run build.mjs"}}\n')
  await writeFile(path.join(shared, 'build.mjs'), buildScript)
  await writeFile(path.join(shared, '.github/workflows/pages.yml'), 'name: Fixture Pages\non: push\n')
  await writeFile(path.join(shared, 'src/data/site-config.generated.json'), '{}\n')
  await writeFile(path.join(theme, 'src/theme/theme.css'), '/* fixture */\n')

  await run(['git', 'init', '-b', 'main'], repository)
  await run(['git', 'config', 'user.name', 'fixture'], repository)
  await run(['git', 'config', 'user.email', 'fixture@example.test'], repository)
  await run(['git', 'add', '.'], repository)
  await run(['git', 'commit', '-m', 'test: add fixture theme'], repository)
  return repository
}
