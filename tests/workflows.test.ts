import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveWorkflowStatePath } from '../scripts/resolve-state-path'

const root = path.resolve(import.meta.dir, '..')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'publume-workflow-'))
  temporaryDirectories.push(directory)
  return directory
}

async function command(argumentsList: string[], cwd: string, env?: Readonly<Record<string, string>>): Promise<string> {
  const process = Bun.spawn(argumentsList, {
    cwd,
    ...(env ? { env: { ...Bun.env, ...env } } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (code !== 0) throw new Error(`${argumentsList.join(' ')} failed: ${stderr.trim() || stdout.trim()}`)
  return stdout.trim()
}

describe('GitHub workflow state boundary', () => {
  test('resolves the default and a configured repository-local state path', async () => {
    const workspace = await temporaryDirectory()

    expect(await resolveWorkflowStatePath({ GITHUB_WORKSPACE: workspace })).toBe('state/decisions.json')
    expect(
      await resolveWorkflowStatePath({ GITHUB_WORKSPACE: workspace, STATE_PATH: 'data/publishing decisions.json' }),
    ).toBe('data/publishing decisions.json')
  })

  test('rejects paths outside the checkout and reserved Git directories', async () => {
    const workspace = await temporaryDirectory()

    for (const statePath of ['../decisions.json', '/tmp/decisions.json', '.git/config', '.publume-upstream/state.json'])
      await expect(resolveWorkflowStatePath({ GITHUB_WORKSPACE: workspace, STATE_PATH: statePath })).rejects.toThrow()
  })

  test('rejects a repository symlink that escapes the checkout', async () => {
    const workspace = await temporaryDirectory()
    const outside = await temporaryDirectory()
    await mkdir(path.join(outside, 'state'))
    await symlink(path.join(outside, 'state'), path.join(workspace, 'state-link'))

    await expect(
      resolveWorkflowStatePath({ GITHUB_WORKSPACE: workspace, STATE_PATH: 'state-link/decisions.json' }),
    ).rejects.toThrow('inside the repository')
  })

  test('preserves state and a user schedule while updating managed files', async () => {
    const directory = await temporaryDirectory()
    const upstream = path.join(directory, 'upstream')
    const managed = path.join(directory, 'managed')
    await mkdir(path.join(upstream, 'src'), { recursive: true })
    await mkdir(path.join(upstream, '.github/workflows'), { recursive: true })
    await mkdir(path.join(managed, 'state'), { recursive: true })
    await mkdir(path.join(managed, 'data'), { recursive: true })
    await mkdir(path.join(managed, '.github/workflows'), { recursive: true })
    await writeFile(path.join(upstream, 'src/core.ts'), 'new core\n')
    await writeFile(path.join(upstream, '.github/workflows/schedule.yml'), 'default daily schedule\n')
    await writeFile(path.join(managed, 'obsolete.txt'), 'obsolete\n')
    await writeFile(path.join(managed, 'state/decisions.json'), 'default state\n')
    await writeFile(path.join(managed, 'data/custom.json'), 'custom state\n')
    await writeFile(path.join(managed, '.github/workflows/schedule.yml'), 'user schedule\n')

    await command(
      [
        'rsync',
        '-a',
        '--delete',
        '--exclude',
        '.git/',
        '--exclude',
        '.publume-upstream/',
        '--exclude',
        'state/',
        '--exclude',
        '/data/custom.json',
        '--exclude',
        '/.github/workflows/schedule.yml',
        `${upstream}/`,
        `${managed}/`,
      ],
      directory,
    )

    expect(await readFile(path.join(managed, 'state/decisions.json'), 'utf8')).toBe('default state\n')
    expect(await readFile(path.join(managed, 'data/custom.json'), 'utf8')).toBe('custom state\n')
    expect(await readFile(path.join(managed, '.github/workflows/schedule.yml'), 'utf8')).toBe('user schedule\n')
    expect(await readFile(path.join(managed, 'src/core.ts'), 'utf8')).toBe('new core\n')
    await expect(readFile(path.join(managed, 'obsolete.txt'), 'utf8')).rejects.toThrow()
  })

  test('rebases a state commit over a concurrent Core update before pushing', async () => {
    const directory = await temporaryDirectory()
    const remote = path.join(directory, 'remote.git')
    const stateCheckout = path.join(directory, 'state-checkout')
    const upgradeCheckout = path.join(directory, 'upgrade-checkout')
    await command(['git', 'init', '--bare', '--initial-branch=main', remote], directory)
    await command(['git', 'clone', remote, stateCheckout], directory)
    await command(['git', 'config', 'user.name', 'publume[test]'], stateCheckout)
    await command(['git', 'config', 'user.email', 'publume@example.com'], stateCheckout)
    await writeFile(path.join(stateCheckout, 'base.txt'), 'base\n')
    await command(['git', 'add', 'base.txt'], stateCheckout)
    await command(['git', 'commit', '-m', 'base'], stateCheckout)
    await command(['git', 'push', '-u', 'origin', 'main'], stateCheckout)
    await command(['git', 'clone', remote, upgradeCheckout], directory)
    await command(['git', 'config', 'user.name', 'publume[test]'], upgradeCheckout)
    await command(['git', 'config', 'user.email', 'publume@example.com'], upgradeCheckout)

    await writeFile(path.join(stateCheckout, 'state.json'), '{}\n')
    await command(['git', 'add', 'state.json'], stateCheckout)
    await command(['git', 'commit', '-m', 'state'], stateCheckout)
    await writeFile(path.join(upgradeCheckout, 'core.txt'), 'upgrade\n')
    await command(['git', 'add', 'core.txt'], upgradeCheckout)
    await command(['git', 'commit', '-m', 'upgrade'], upgradeCheckout)
    await command(['git', 'push', 'origin', 'main'], upgradeCheckout)

    await command(['bash', path.join(root, 'scripts/push-current-branch.sh')], stateCheckout, {
      GITHUB_REF_NAME: 'main',
      GITHUB_TOKEN: 'test-token',
    })
    await command(['git', 'pull', 'origin', 'main'], upgradeCheckout)
    expect(await readFile(path.join(upgradeCheckout, 'state.json'), 'utf8')).toBe('{}\n')
    expect(await readFile(path.join(upgradeCheckout, 'core.txt'), 'utf8')).toBe('upgrade\n')
  })

  test('keeps each operation serialized, scopes secrets, and verifies upgrades', async () => {
    const generate = await readFile(path.join(root, '.github/workflows/generate.yml'), 'utf8')
    const schedule = await readFile(path.join(root, '.github/workflows/schedule.yml'), 'utf8')
    const upgrade = await readFile(path.join(root, '.github/workflows/upgrade.yml'), 'utf8')
    const scheduler = await readFile(path.join(root, 'scheduler/wrangler.toml'), 'utf8')

    expect(generate).toContain('group: publume-generate')
    expect(upgrade).toContain('group: publume-upgrade')
    for (const workflow of [generate, upgrade]) expect(workflow).toContain('persist-credentials: false')
    expect(generate.indexOf(`AI_API_KEY: \${{ secrets.AI_API_KEY }}`)).toBeGreaterThan(
      generate.indexOf('- name: Run Publume Core'),
    )
    expect(generate.indexOf(`PRODUCTHUNT_API_TOKEN: \${{ secrets.PRODUCTHUNT_API_TOKEN }}`)).toBeGreaterThan(
      generate.indexOf('- name: Run Publume Core'),
    )
    expect(generate).not.toContain('PUBLUME_LOCAL')
    expect(generate).not.toContain('SITE_ARTICLE_TITLE_MAX_SIZE')
    expect(generate).toContain('options: [run, initial, bootstrap]')
    expect(generate).toContain('AI_CONCURRENCY:')
    expect(generate).toContain('vars.AI_CONCURRENCY')
    expect(generate).toContain('bun src/cli.ts --mode="$PUBLUME_MODE"')
    expect(generate).toContain('workflow_call:')
    expect(generate).toContain('actions: read')
    expect(generate).toContain("if: github.event_name == 'schedule'")
    expect(generate).toContain('bun scripts/schedule-gate.ts')
    expect(generate).toContain('continue-on-error: true')
    expect(generate).toContain('id: core')
    expect(generate).toContain("if: always() && steps.core.outcome != 'skipped'")
    expect(schedule).toContain("cron: '0 0 * * *'")
    expect(schedule).toContain('uses: ./.github/workflows/generate.yml')
    expect(schedule).toContain('secrets: inherit')
    expect(scheduler).toContain('crons = ["50 23 * * *"]')
    expect(upgrade).toContain('--exclude "/$state_path"')
    expect(upgrade).toContain("--exclude '/.github/workflows/schedule.yml'")
    expect(upgrade.indexOf('bun run check')).toBeLessThan(upgrade.indexOf('- name: Commit the upgrade'))
    expect(upgrade).toContain(`Upstream-Commit: \${CORE_SHA}`)
    expect(upgrade).toContain('bun .publume-upstream/scripts/resolve-state-path.ts')
    expect(upgrade).toContain(
      'cp .publume-upstream/scripts/push-current-branch.sh "$RUNNER_TEMP/publume-push-current-branch.sh"',
    )
    expect(upgrade).toContain(`GITHUB_TOKEN: \${{ secrets.TARGET_REPO_TOKEN || github.token }}`)
    expect(generate).toContain('bash scripts/push-current-branch.sh')
    expect(upgrade).toContain('bash "$RUNNER_TEMP/publume-push-current-branch.sh"')
  })
})
