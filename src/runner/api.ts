import type { FlowBundleManifest } from '@shared/flow-bundle'
import type { WorkflowRun } from '@shared/types'

export interface RunnerField {
  key: string
  label: string
  kind: 'text' | 'long' | 'number' | 'boolean' | 'json'
  value: unknown
}

export interface RunnerState {
  manifest: FlowBundleManifest
  flow: { name: string; description: string; nodes: { id: string; label: string; type: string }[] }
  fields: RunnerField[]
  hasKey: boolean
  model: string | null
  models: string[]
  workspace: string
}

/** What the Flow Runner window can ask its main process for. */
export interface RunnerApi {
  state(): Promise<RunnerState>
  /** Save an OpenAI key after checking it works; loads the model list. */
  setKey(key: string): Promise<RunnerState>
  clearKey(): Promise<RunnerState>
  setModel(id: string): Promise<RunnerState>
  pickWorkspace(): Promise<RunnerState>
  run(input: unknown): Promise<WorkflowRun>
  cancel(runId: string): Promise<void>
  runs(): Promise<WorkflowRun[]>
  openPath(path: string): Promise<void>
  showInFolder(path: string): Promise<void>
}

export type RunnerEvent = { type: 'run'; run: WorkflowRun }
