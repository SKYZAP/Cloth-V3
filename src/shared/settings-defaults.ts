import { DEFAULT_TIER_INSTRUCTIONS, type AgentTier, type Settings } from './types'

/** The tiers a chat agent picks from when it delegates; model null = the chat's own model. */
export const DEFAULT_AGENT_TIERS: AgentTier[] = [
  { id: 'light', name: 'Low', model: null, thinking: 'low', purpose: 'Mechanical edits, renames, running builds or tests, small isolated fixes.', instructions: DEFAULT_TIER_INSTRUCTIONS.light },
  { id: 'medium', name: 'Medium', model: null, thinking: 'medium', purpose: 'Standard features and bug fixes with a known cause, a few files.', instructions: DEFAULT_TIER_INSTRUCTIONS.medium },
  { id: 'careful', name: 'High', model: null, thinking: 'high', purpose: 'Delicate changes where the approach is clear: multi-file refactors, edge cases, keeping invariants.', instructions: DEFAULT_TIER_INSTRUCTIONS.careful },
  { id: 'heavy', name: 'Max', model: null, thinking: 'xhigh', purpose: 'Unclear causes, unfamiliar or messy code, where a wrong first approach is expensive.', instructions: DEFAULT_TIER_INSTRUCTIONS.heavy }
]

export const DEFAULT_SETTINGS: Settings = {
  defaultModel: null,
  defaultDesignId: null,
  embeddingModel: null,
  webEngine: 'obscura',
  searxngUrl: '',
  webCaCertPath: '',
  obscuraPath: '',
  webResults: 6,
  webAllowPrivate: false,
  examplesLoaded: false,
  examplesHash: '',
  mcpEnabled: true,
  mcpPort: 7811,
  mcpRequireToken: false,
  mcpClients: [],
  chunkSize: 1600,
  chunkOverlap: 200,
  autoCompact: true,
  aiTitles: true,
  titleModel: null,
  starredModels: [],
  imageModel: null,
  remoteEnabled: false,
  remotePort: 7812,
  remoteKeepAwake: true,
  swatchNetwork: false,
  swatchPort: 7841,
  chatTheme: 'crimson-flow',
  chatThemes: [],
  chatThemeStrength: 0.55,
  subagents: {
    enabledByDefault: true,
    model: null,
    thinking: 'inherit',
    maxTurns: 30,
    maxParallel: 4,
    allowWorkers: true,
    maxAccess: 'operator',
    reviewModel: null,
    instructions: ''
  },
  agentTiers: DEFAULT_AGENT_TIERS,
  defaultPermissions: 'manual',
  codingRules: '',
  defaultWorkspace: null,
  languages: [],
  onboarding: null
}
