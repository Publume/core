import { realpath } from 'node:fs/promises'
import path from 'node:path'

type WorkflowEnvironment = Readonly<Record<string, string | undefined>>

async function resolveMissingPath(input: string): Promise<string> {
  const missingParts: string[] = []
  let current = input
  while (true) {
    try {
      return path.join(await realpath(current), ...missingParts)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      missingParts.unshift(path.basename(current))
      current = parent
    }
  }
}

export async function resolveWorkflowStatePath(env: WorkflowEnvironment = process.env): Promise<string> {
  const workspace = await realpath(env.GITHUB_WORKSPACE ?? process.cwd())
  const configuredPath = env.STATE_PATH?.trim() || 'state/decisions.json'
  if (path.isAbsolute(configuredPath) || /[\r\n]/.test(configuredPath))
    throw new Error('STATE_PATH must be a repository-relative path')

  const resolvedPath = await resolveMissingPath(path.resolve(workspace, configuredPath))
  const relativePath = path.relative(workspace, resolvedPath)
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  )
    throw new Error('STATE_PATH must stay inside the repository checkout')

  const [root] = relativePath.split(path.sep)
  if (root === '.git' || root === '.publume-upstream')
    throw new Error(`STATE_PATH cannot use the reserved ${root} path`)
  return relativePath
}

if (import.meta.main) console.log(await resolveWorkflowStatePath())
