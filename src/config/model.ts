import type { EditorialProfile } from './profiles'

export type Source = {
  readonly id: string
  readonly url: string
}

export type AiConfig = {
  readonly provider: string
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
  readonly allowedModels: readonly string[]
  readonly responseFormat: 'json_object' | 'json_schema'
  readonly timeoutMs: number
  readonly concurrency: number
}

export type EditorialConfig = {
  readonly profile: EditorialProfile
  readonly instructions: string
  readonly gatePrompt: string
  readonly articlePrompt: string
  readonly languages: readonly string[]
  readonly publishThreshold: number
  readonly deduplicationContextSize: number
}

export type SourceConfig = {
  readonly entries: readonly Source[]
  readonly productHuntApiToken: string
  readonly timeoutMs: number
  readonly maxItemAgeHours: number
  readonly maxCandidatesPerRun: number
  readonly minimumContentLength: number
  readonly enrichmentSearchUrlTemplate: string
}

export type TargetConfig = {
  readonly repository: string
  readonly token: string
  readonly branch: string
}

export type StateConfig = {
  readonly path: string
  readonly maxRecords: number
  readonly maxPendingDeliveries: number
}

export type DeliveryChannelConfig =
  | { readonly id: string; readonly type: 'telegram'; readonly botToken: string; readonly chatId: string }
  | {
      readonly id: string
      readonly type: 'discord' | 'slack' | 'wecom'
      readonly webhookUrl: string
    }
  | {
      readonly id: string
      readonly type: 'feishu' | 'dingtalk'
      readonly webhookUrl: string
      readonly signingSecret?: string
    }
  | { readonly id: string; readonly type: 'ntfy'; readonly topicUrl: string }
  | {
      readonly id: string
      readonly type: 'matrix'
      readonly homeserver: string
      readonly roomId: string
      readonly accessToken: string
    }
  | {
      readonly id: string
      readonly type: 'resend'
      readonly apiKey: string
      readonly from: string
      readonly to: readonly string[]
    }
  | {
      readonly id: string
      readonly type: 'webhook'
      readonly url: string
      readonly headers: Readonly<Record<string, string>>
    }

export type ThemeConfig = {
  readonly repository: string
  readonly ref: string
  readonly id: string
}

export type SiteConfig = {
  readonly url: string
  readonly name: string
  readonly description: string
  readonly tagline: string
  readonly locale: string
  readonly outputLanguages: readonly string[]
  readonly defaultContentLanguage: string
  readonly publisherName: string
  readonly authorName: string
  readonly contactUrl: string
  readonly aiDisclosure: string
  readonly socialImageUrl: string
  readonly newsletterUrl: string
  readonly sponsorUrl: string
  readonly showTopics: boolean
  readonly showScore: boolean
  readonly showSources: boolean
  readonly footerText: string
}

export type AppConfig = {
  readonly ai: AiConfig
  readonly editorial: EditorialConfig
  readonly sources: SourceConfig
  readonly target: TargetConfig
  readonly state: StateConfig
  readonly delivery: { readonly channels: readonly DeliveryChannelConfig[] }
  readonly theme: ThemeConfig
  readonly site: SiteConfig
}
