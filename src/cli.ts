import { createDeliveryChannels } from './adapters/delivery'
import { createEditorial } from './adapters/editorial'
import { createFileDecisionStore } from './adapters/file-decisions'
import { createOpenAiClient } from './adapters/openai'
import { createSitePublisher } from './adapters/site-publisher'
import { createSourceReader } from './adapters/sources/reader'
import { type RunOptions, runPipeline } from './app/pipeline'
import type { PipelinePorts } from './app/ports'
import { loadConfig } from './config/load'
import type { AppConfig } from './config/model'

function createPorts(config: AppConfig): PipelinePorts {
  return {
    sources: createSourceReader(
      config.sources.entries,
      config.sources.timeoutMs,
      fetch,
      undefined,
      config.sources.enrichmentSearchUrlTemplate,
    ),
    editorial: createEditorial(config.editorial, createOpenAiClient(config.ai)),
    decisions: createFileDecisionStore(config.state.path),
    site: createSitePublisher(config),
    delivery: createDeliveryChannels(config.delivery.channels),
  }
}

function runMode(argumentsList: readonly string[]): RunOptions['mode'] {
  if (argumentsList.includes('--initial')) return 'initial'
  if (argumentsList.includes('--bootstrap')) return 'bootstrap'
  const explicitMode = argumentsList.find((argument) => argument.startsWith('--mode='))?.slice('--mode='.length)
  if (explicitMode === undefined || explicitMode === 'run') return 'run'
  if (explicitMode === 'initial' || explicitMode === 'bootstrap') return explicitMode
  throw new Error(`Unsupported run mode: ${explicitMode}`)
}

async function main(): Promise<void> {
  const config = loadConfig()
  console.log(JSON.stringify(await runPipeline(config, createPorts(config), { mode: runMode(process.argv.slice(2)) })))
}

if (import.meta.main) await main()
