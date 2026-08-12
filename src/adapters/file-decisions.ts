import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { DecisionStore } from '../app/ports'
import { type DecisionState, emptyDecisionState } from '../domain/decisions'

const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'invalid timestamp')
const record = z
  .object({
    decisionKey: z.string().min(1),
    status: z.enum(['rejected', 'generated', 'published', 'failed']),
    configHash: z.string().min(1),
    updatedAt: timestamp,
    reason: z.string().optional(),
    score: z.number().min(0).max(1).optional(),
    targetCommitSha: z.string().min(1).optional(),
    candidateTitle: z.string().min(1).optional(),
    canonicalUrl: z.url().optional(),
    modelFailureCount: z.number().int().positive().optional(),
  })
  .strict()

const stateSchema = z
  .object({
    version: z.literal(1),
    decisions: z.record(z.string(), record),
    processedCandidates: z.record(z.string().min(1), timestamp).optional(),
    sourceCheckpoints: z.record(z.string().min(1), timestamp).default({}),
    pendingDeliveries: z
      .array(
        z
          .object({
            id: z.string().min(1),
            channelId: z.string().min(1),
            article: z
              .object({
                language: z.string().min(1),
                title: z.string().min(1),
                summary: z.string().min(1),
                sourceUrls: z.array(z.url()),
              })
              .strict(),
            createdAt: timestamp,
            attempts: z.number().int().nonnegative(),
            lastError: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    configHash: z.string().min(1).optional(),
    lastRunAt: timestamp.optional(),
  })
  .strict()

export function createFileDecisionStore(filePath: string): DecisionStore {
  return {
    async load(): Promise<DecisionState> {
      try {
        const value: unknown = JSON.parse(await readFile(filePath, 'utf8'))
        return stateSchema.parse(value)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDecisionState()
        throw new Error('invalid decisions state', { cause: error })
      }
    },

    async save(state): Promise<void> {
      await mkdir(path.dirname(filePath), { recursive: true })
      const temporaryPath = `${filePath}.tmp-${process.pid}`
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      // Rename keeps readers from observing a partially written state file after interruption.
      await rename(temporaryPath, filePath)
    },
  }
}
