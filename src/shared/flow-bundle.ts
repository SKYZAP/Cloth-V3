import type { CustomToolInput, SourceType, WorkflowEdge, WorkflowNode } from './types'

/**
 * What an exported flow app carries in resources/bundle. Written by Cloth's exporter, read by the
 * Flow Runner template (the same prebuilt app for every export).
 */
export const BUNDLE_FORMAT = 1

export interface FlowBundleManifest {
  format: typeof BUNDLE_FORMAT
  /** App name shown in the window, installer and Start menu. */
  name: string
  /** Stable id: user data folder and Windows app id, so exported apps never share settings. */
  appId: string
  description: string
  version: string
  /** OpenAI model preselected in the app (the user can change it). */
  model: string | null
  /** The flow uses web search / pages (Obscura is bundled). */
  web: boolean
  exportedAt: number
  clothVersion: string
}

export interface FlowBundleGraph {
  name: string
  description: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface CollectionSnapshot {
  name: string
  description: string
  documents: { title: string; source: string; sourceType: SourceType; chunks: { headingPath: string; text: string }[] }[]
}

/** Files inside resources/bundle. */
export const BUNDLE_FILES = {
  manifest: 'manifest.json',
  flow: 'flow.json',
  tools: 'tools.json',
  skills: 'skills',
  knowledge: 'knowledge'
} as const

export type BundledTool = CustomToolInput

/** A knowledge file: the snapshot plus the collection id it had in Cloth (flow nodes refer to it). */
export interface BundledCollection {
  id: string
  snapshot: CollectionSnapshot
}

// ─── Export (Cloth side) ─────────────────────────────────────────────────────

/** What a flow needs to run on its own — decides what goes into an exported app. */
export interface ExportPlan {
  tools: string[]
  skills: string[]
  /** Collection ids, snapshotted with keyword search only. */
  collections: string[]
  /** Web search or page fetching: Obscura is bundled. */
  web: boolean
  /** Blocking problems: the export stops. */
  errors: string[]
  /** Things that may not work on another computer. */
  warnings: string[]
}

export interface ExportPreview {
  plan: ExportPlan
  /** Missing pieces of the export toolchain (runner template, NSIS, Obscura). Empty = ready. */
  missing: string[]
  /** Where installers go by default. */
  defaultOutputDir: string
}

export interface ExportInput {
  workflowId: string
  name: string
  description: string
  version: string
  /** OpenAI model preselected in the app. */
  model: string | null
  outputDir: string
  /** installer (default) or a ready-to-run folder. */
  format?: 'installer' | 'folder'
}

export type ExportEvent =
  | { exportId: string; type: 'step'; step: number; steps: number; title: string; at: number }
  | { exportId: string; type: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: number }
  | { exportId: string; type: 'done'; file: string; bytes: number; durationMs: number; at: number }
  | { exportId: string; type: 'failed'; message: string; cancelled: boolean; at: number }
