import path from 'node:path'
import type { TargetConfig } from '../config/model'

export type CommandResult = {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

export async function runCommand(
  args: readonly string[],
  cwd: string,
  env?: Record<string, string>,
  inheritEnv = true,
): Promise<CommandResult> {
  const processEnv = inheritEnv ? { ...process.env, ...env } : env
  const child = Bun.spawn([...args], { cwd, env: processEnv, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}

export async function git(args: readonly string[], cwd: string, env?: Record<string, string>): Promise<string> {
  const result = await runCommand(['git', ...args], cwd, env)
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  return result.stdout.trim()
}

export function repositoryUrl(repository: string): string {
  if (/^(https?|file|ssh):\/\//.test(repository) || /^[^@]+@[^:]+:.+/.test(repository)) return repository
  if (repository.startsWith('/') || repository.startsWith('.')) return path.resolve(repository)
  return `https://github.com/${repository}.git`
}

export function targetGitEnvironment(target: TargetConfig): Record<string, string> {
  if (!target.token || !repositoryUrl(target.repository).startsWith('https://github.com/')) return {}
  const authorization = Buffer.from(`x-access-token:${target.token}`).toString('base64')
  // Git receives the token through process configuration, keeping it out of clone URLs and error output.
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
  }
}
