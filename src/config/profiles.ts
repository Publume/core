import type { StoryBlockKind } from '../domain/content'

export const editorialProfileIds = [
  'general',
  'briefing',
  'analysis',
  'explainer',
  'research-review',
  'risk-advisory',
  'policy-tracker',
  'market-intelligence',
  'product-update',
] as const

export type EditorialProfileId = (typeof editorialProfileIds)[number]
export type EnrichmentToolId = 'web-search'

export type EditorialStoryBlock = {
  readonly kind: StoryBlockKind
  readonly optional?: boolean
  readonly tools?: readonly EnrichmentToolId[]
}

export type EditorialProfile = {
  readonly id: EditorialProfileId
  readonly admissionPrompt: string
  readonly gatePrompt: string
  readonly articlePrompt: string
  readonly minimumEvidenceSources: number
  readonly storyBlocks: readonly EditorialStoryBlock[]
  readonly maximumEnrichedStoriesPerRun: number
  readonly maximumEnrichmentResultsPerStory: number
}

const commonGate = [
  'Decide whether the story contains material new information for the configured audience, not merely whether it is topically related.',
  'Reject placeholders, stale or duplicate coverage, promotional copy, unsupported predictions, and opinion presented as fact. Every approved claim must point to supplied evidence.',
].join(' ')

const commonArticle = [
  'Write only from approved claims and explicit uncertainty. Attribute source-specific statements and do not invent facts, quotations, figures, chronology, links, or sources.',
  'Choose length from the amount of evidence. Avoid repetition, padding, generic scene-setting, boilerplate conclusions, and calls to action.',
].join(' ')

export const editorialProfiles: Readonly<Record<EditorialProfileId, EditorialProfile>> = {
  general: {
    id: 'general',
    admissionPrompt:
      'Use this broad fallback for mixed sources or publications without a more specific editorial task. Prioritize fresh, specific developments with a clear change, actor, time frame, and consequence for the configured audience. Demote commentary, recycled announcements, and minor updates.',
    gatePrompt: `${commonGate} Prefer primary or authoritative evidence. Keep the decision and any approved claims narrowly bounded when only one source establishes the development. Do not impose a subject-specific importance test that the configured audience did not request.`,
    articlePrompt: `${commonArticle} Lead with the new development and its supported consequence. Include only the context and uncertainty needed to understand it; do not force a specialist format onto the story.`,
    minimumEvidenceSources: 1,
    storyBlocks: [
      { kind: 'summary' },
      { kind: 'key-points' },
      { kind: 'context', optional: true, tools: ['web-search'] },
      { kind: 'uncertainty', optional: true, tools: ['web-search'] },
    ],
    maximumEnrichedStoriesPerRun: 2,
    maximumEnrichmentResultsPerStory: 2,
  },
  briefing: {
    id: 'briefing',
    admissionPrompt:
      'Prioritize actionable changes and a balanced mix of distinct topics. Prefer items that a busy reader can understand and act on quickly over incremental noise, background essays, and changes with no concrete consequence.',
    gatePrompt: `${commonGate} Approve only developments that support a compact briefing with a concrete reader takeaway. Preserve exact dates, scope, thresholds, and next milestones when they determine what the reader should do or watch.`,
    articlePrompt: `${commonArticle} Write for fast scanning. State the development and essential points first, then add a consequence or next milestone only when the evidence supports one. Do not turn the briefing into a compressed long-form essay.`,
    minimumEvidenceSources: 1,
    storyBlocks: [
      { kind: 'summary' },
      { kind: 'key-points' },
      { kind: 'impact', optional: true, tools: ['web-search'] },
      { kind: 'watch', optional: true, tools: ['web-search'] },
    ],
    maximumEnrichedStoriesPerRun: 3,
    maximumEnrichmentResultsPerStory: 2,
  },
  analysis: {
    id: 'analysis',
    admissionPrompt:
      'Prioritize developments with enough independent material for explanation, comparison, causal context, or competing interpretations. Demote thin announcements that support only a short update.',
    gatePrompt: `${commonGate} Require multiple evidence sources for interpretive claims. A measured material difference with independent methodological documentation can qualify even when production applicability remains uncertain; treat that limitation as a caveat, not an automatic rejection. Separate established facts, source interpretations, conflicts, and the publication's own bounded inference. Reject a requested causal explanation when the evidence supports only correlation or chronology.`,
    articlePrompt: `${commonArticle} Build an evidence-led analysis: establish the development and relevant baseline, compare the strongest supported explanations, and state caveats or unresolved questions explicitly. Never hide inference inside factual wording.`,
    minimumEvidenceSources: 2,
    storyBlocks: [
      { kind: 'lead' },
      { kind: 'key-points' },
      { kind: 'context', tools: ['web-search'] },
      { kind: 'analysis', tools: ['web-search'] },
      { kind: 'uncertainty', optional: true, tools: ['web-search'] },
      { kind: 'watch', optional: true },
    ],
    maximumEnrichedStoriesPerRun: 5,
    maximumEnrichmentResultsPerStory: 3,
  },
  explainer: {
    id: 'explainer',
    admissionPrompt:
      'Prioritize source material that explains a meaningful problem, mechanism, implementation, or decision with concrete evidence, tradeoffs, and lessons transferable beyond one announcement. Demote release notes, documentation recaps, thin tutorials, search-optimized filler, and unsupported opinion.',
    gatePrompt: `${commonGate} Judge the explanatory value of the material itself rather than its subject, length, author, or publisher. Require a clear question or problem, a supported account of how or why, practical specificity, and honest limitations.`,
    articlePrompt: `${commonArticle} Retell the evidence as a connected explanation for a busy reader: establish the problem and constraints, reconstruct the mechanism or solution, then state only the broader takeaway the evidence supports. Preserve baselines, units, conditions, tradeoffs, and limitations. Attribute arguments and interpretations to their sources.`,
    minimumEvidenceSources: 1,
    storyBlocks: [{ kind: 'background' }, { kind: 'solution' }, { kind: 'takeaway' }],
    maximumEnrichedStoriesPerRun: 0,
    maximumEnrichmentResultsPerStory: 0,
  },
  'research-review': {
    id: 'research-review',
    admissionPrompt:
      'Prioritize credible studies with a clear question, method, result, and significance. Reward primary evidence, meaningful comparisons or effect sizes, transparent limitations, and replication value; demote press-release exaggeration, benchmark headlines without conditions, and correlation presented as causation.',
    gatePrompt: `${commonGate} Judge study design, sample and controls, measurement, baseline quality, effect size, uncertainty, review status, replication, and whether the conclusion stays within the studied population and conditions. Separate the study result from institutional, vendor, or media interpretation.`,
    articlePrompt: `${commonArticle} Explain the research question, method, principal finding, comparison or effect size, and limitations in accessible language. Preserve datasets or populations, sample size, controls, units, uncertainty, review status, and evaluation conditions. Never generalize beyond the evidence or convert association into causation.`,
    minimumEvidenceSources: 1,
    storyBlocks: [
      { kind: 'summary' },
      { kind: 'context', optional: true, tools: ['web-search'] },
      { kind: 'analysis', tools: ['web-search'] },
      { kind: 'uncertainty', optional: true, tools: ['web-search'] },
    ],
    maximumEnrichedStoriesPerRun: 4,
    maximumEnrichmentResultsPerStory: 3,
  },
  'risk-advisory': {
    id: 'risk-advisory',
    admissionPrompt:
      'Prioritize verified incidents, vulnerabilities, service hazards, privacy changes, recalls, and other time-sensitive risks with a defined affected population or system and concrete defensive guidance. Demote anonymous alarm, proof-free universal claims, speculative danger, and fear marketing.',
    gatePrompt: `${commonGate} Distinguish confirmed harm or exploitation, demonstrated possibility, source allegation, official assessment, and unresolved report. Preserve affected scope, prerequisites, severity basis, indicators, and sourced mitigation. Reject claims that cannot identify what is affected or how the conclusion was established.`,
    articlePrompt: `${commonArticle} Lead with what is affected and the verified status. Separate evidence, triggering conditions, impact, and sourced mitigation. Never widen scope beyond named populations, versions, regions, or systems; never claim harm without evidence or invent remediation. This format provides sourced information, not individualized medical, legal, financial, or safety advice.`,
    minimumEvidenceSources: 1,
    storyBlocks: [
      { kind: 'summary' },
      { kind: 'key-points' },
      { kind: 'context', optional: true, tools: ['web-search'] },
      { kind: 'uncertainty', optional: true, tools: ['web-search'] },
      { kind: 'watch', optional: true },
    ],
    maximumEnrichedStoriesPerRun: 5,
    maximumEnrichmentResultsPerStory: 3,
  },
  'policy-tracker': {
    id: 'policy-tracker',
    admissionPrompt:
      'Prioritize enacted laws, final regulations, binding directives, court decisions, formal consultations, and material policy changes with identifiable scope, dates, obligations, or rights. Demote political rhetoric, draft language reported as final, unsourced legal predictions, and commentary without a new official development.',
    gatePrompt: `${commonGate} Distinguish proposal, consultation, vote, enactment, publication, effective date, enforcement, and court status. Require an identifiable authority, jurisdiction, affected parties, operative provision, and current procedural status. An official final rule with a stated effective date, threshold, and obligation is a qualifying material change even before that date arrives. Do not infer legal obligations beyond the supplied text.`,
    articlePrompt: `${commonArticle} State the authority, jurisdiction, current status, operative date, affected parties, and concrete obligation or change. Separate final rules from proposals and interpretation. Preserve every supplied threshold and exception, including groups explicitly outside the rule, and avoid legal advice or unsupported compliance conclusions.`,
    minimumEvidenceSources: 1,
    storyBlocks: [
      { kind: 'summary' },
      { kind: 'context', tools: ['web-search'] },
      { kind: 'impact', tools: ['web-search'] },
      { kind: 'uncertainty', optional: true },
      { kind: 'watch', optional: true },
    ],
    maximumEnrichedStoriesPerRun: 4,
    maximumEnrichmentResultsPerStory: 3,
  },
  'market-intelligence': {
    id: 'market-intelligence',
    admissionPrompt:
      'Prioritize material company, pricing, partnership, acquisition, financing, supply-chain, competitive, and market-structure changes that alter what customers, operators, or competitors can do. Demote routine price movement, ceremonial partnerships, vague strategy statements, market gossip, and announcements without commitments, figures, availability, or named counterparties.',
    gatePrompt: `${commonGate} Judge materiality, commitment level, affected segment, competitive consequence, and source authority. Distinguish signed agreements from talks, actual results from forecasts, shipped offers from roadmaps, list prices from negotiated contracts, and company claims from observed market evidence. Preserve currency, units, periods, and comparison baselines.`,
    articlePrompt: `${commonArticle} Lead with the concrete company or market change, then explain the affected segment, relevant baseline, and supported competitive or operational consequence. Preserve deal status, amounts, price units, periods, availability, conditions, and named counterparties. Do not give investment advice or predict inevitable price movements.`,
    minimumEvidenceSources: 1,
    storyBlocks: [
      { kind: 'summary' },
      { kind: 'key-points' },
      { kind: 'context', tools: ['web-search'] },
      { kind: 'impact', optional: true, tools: ['web-search'] },
      { kind: 'watch', optional: true },
    ],
    maximumEnrichedStoriesPerRun: 3,
    maximumEnrichmentResultsPerStory: 2,
  },
  'product-update': {
    id: 'product-update',
    admissionPrompt:
      'Prioritize material releases, availability changes, deprecations, migrations, compatibility changes, platform policies, service shutdowns, and documented roadmap changes. Require named products or services plus a version, date, affected plan or platform, changed behavior, or migration consequence. Demote teaser-only promotion, minor cosmetic patches, rumor, and release notes with no meaningful user impact.',
    gatePrompt: `${commonGate} Judge whether the item materially changes availability, supported environments, behavior, access, compatibility, cost, or migration work. Distinguish generally available releases from previews and roadmaps, official announcements from leaks, and changed defaults from optional features. Preserve version, platform, region, plan, rollout, and compatibility conditions.`,
    articlePrompt: `${commonArticle} State the product, exact change, release status, date or version, and affected users first. Preserve availability, platform, region, plan, compatibility, migration, rollback, and rollout details. Explain impact only when the evidence identifies a concrete consequence; do not turn rumors or roadmap targets into shipped features.`,
    minimumEvidenceSources: 1,
    storyBlocks: [
      { kind: 'summary' },
      { kind: 'key-points' },
      { kind: 'context', optional: true, tools: ['web-search'] },
      { kind: 'impact', optional: true, tools: ['web-search'] },
      { kind: 'watch', optional: true },
    ],
    maximumEnrichedStoriesPerRun: 3,
    maximumEnrichmentResultsPerStory: 2,
  },
}

export function editorialProfile(id: string): EditorialProfile {
  if (editorialProfileIds.includes(id as EditorialProfileId)) return editorialProfiles[id as EditorialProfileId]
  throw new Error(`Unsupported SITE_TYPE: ${id}`)
}
