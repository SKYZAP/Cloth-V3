import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { plainSecrets } from '../src/main/core/context'
import { createServices } from '../src/main/services'
import { flowToAutomation } from '../src/main/workflows/convert'
import type { WorkflowEdge, WorkflowNode } from '../src/shared/types'
import { REPO } from './helpers'

function open(dataDir: string) {
  return createServices({ dataDir, secrets: plainSecrets, dbFile: join(dataDir, 'cloth.db'), sidecarsDir: join(REPO, 'sidecars'), examplesDir: join(REPO, 'resources', 'examples') })
}

/** Modelled on a "Daily NestJS Knowledge Base Refresh" flow: cron → web search → fetch → agent → ingest tool → output. */
function nestjsRefresh(kbId: string): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: [
      { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { key: 'trigger', label: 'Every morning', defaultInput: '{}' } },
      { id: 'w', type: 'web', position: { x: 200, y: 0 }, data: { key: 'search', label: 'Search news', query: 'NestJS release notes this week', k: 5, fetchTop: 3 } },
      { id: 'h', type: 'http', position: { x: 400, y: 0 }, data: { key: 'releases', label: 'GitHub releases', method: 'GET', url: 'https://api.github.com/repos/nestjs/nest/releases?per_page=5', headers: '{}', body: '' } },
      {
        id: 'a',
        type: 'agent',
        position: { x: 600, y: 0 },
        data: { key: 'notes', label: 'Write notes', prompt: 'Summarise what changed in NestJS from {{search.text}} and {{releases.body}} as short reference notes.', system: 'Be factual; cite links.', collectionIds: [kbId], webEnabled: true }
      },
      { id: 'k', type: 'tool', position: { x: 800, y: 0 }, data: { key: 'ingest', label: 'Add to knowledge', tool: 'kb_ingest', args: { collection: 'NestJS', text: '{{notes}}' } } },
      { id: 'o', type: 'output', position: { x: 1000, y: 0 }, data: { key: 'result', label: 'Output', value: '{{notes}}' } }
    ],
    edges: [
      { id: 'e1', source: 't', target: 'w' },
      { id: 'e2', source: 'w', target: 'h' },
      { id: 'e3', source: 'h', target: 'a' },
      { id: 'e4', source: 'a', target: 'k' },
      { id: 'e5', source: 'k', target: 'o' }
    ]
  }
}

describe('converting flows into automations', () => {
  it('turns a flow into a prompt of numbered steps and the tools they used', () => {
    const a = flowToAutomation({ name: 'Daily NestJS Knowledge Base Refresh', workspace: null, ...nestjsRefresh('col_kb') })
    expect(a.prompt).toBe(
      [
        'This automation was converted from the flow “Daily NestJS Knowledge Base Refresh”. Do these steps in order:',
        [
          '1. Search the web for “NestJS release notes this week” and read the top 3 results.',
          '2. Fetch https://api.github.com/repos/nestjs/nest/releases?per_page=5.',
          '3. Summarise what changed in NestJS from the result of step 1 and the result of step 2 as short reference notes. (Instructions: Be factual; cite links.)',
          '4. Use kb_ingest with collection “NestJS”, text “the result of step 3”.',
          '5. Report the result.'
        ].join('\n')
      ].join('\n\n')
    )
    expect(a.tools.sort()).toEqual(['kb_ingest', 'web_fetch', 'web_search'])
    expect(a).toMatchObject({ agentId: null, collectionIds: ['col_kb'], skills: [], servers: [], watch: null, commands: null })
  })

  it('writes branches, loops and unknown steps as sentences', () => {
    const nodes: WorkflowNode[] = [
      { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { key: 'trigger', defaultInput: '{"question":"What changed?"}' } },
      { id: 'r', type: 'rag', position: { x: 100, y: 0 }, data: { key: 'search', query: '{{input.question}}', collectionIds: ['c1'] } },
      { id: 'c', type: 'condition', position: { x: 200, y: 0 }, data: { key: 'has_hits', label: 'Any hits?', expression: 'prev.hits.length > 0' } },
      { id: 'l', type: 'loop', position: { x: 300, y: 0 }, data: { key: 'each', mode: 'each', items: '{{search.hits}}' } },
      { id: 's', type: 'skill', position: { x: 400, y: 0 }, data: { key: 'sum', skill: 'summarise', mode: 'apply', prompt: 'Summarise {{loop.item}}' } },
      { id: 'n', type: 'output', position: { x: 300, y: 200 }, data: { key: 'none', value: 'No matching documents.' } },
      { id: 'x', type: 'mystery' as WorkflowNode['type'], position: { x: 500, y: 0 }, data: { key: 'x', label: 'Polish' } }
    ]
    const edges: WorkflowEdge[] = [
      { id: '1', source: 't', target: 'r' },
      { id: '2', source: 'r', target: 'c' },
      { id: '3', source: 'c', target: 'l', sourceHandle: 'true' },
      { id: '4', source: 'c', target: 'n', sourceHandle: 'false' },
      { id: '5', source: 'l', target: 's', sourceHandle: 'body' },
      { id: '6', source: 's', target: 'l', targetHandle: 'next' },
      { id: '7', source: 'l', target: 'x', sourceHandle: 'done' }
    ]
    const a = flowToAutomation({ name: 'Digest', workspace: null, nodes, edges })
    expect(a.prompt).toContain('1. Search the knowledge base for “the input\'s question”.')
    expect(a.prompt).toContain('2. If `prev.hits.length > 0` (Any hits?), then continue with step 3; otherwise continue with step 5.')
    expect(a.prompt).toContain('3. For each item in the hits from step 1, do step 4.')
    expect(a.prompt).toContain('4. Use the “summarise” skill: Summarise the current item.')
    expect(a.prompt).toContain('5. Report “No matching documents.”')
    expect(a.prompt).toContain('6. Step: Polish.')
    expect(a.prompt).toContain('The input: `{"question":"What changed?"}`')
    expect(a).toMatchObject({ collectionIds: ['c1'], skills: ['summarise'] })
  })

  it('backs up and converts graph flows at every startup, keeps their schedule, and leaves automations alone', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cloth-convert-'))
    const first = open(dataDir)
    const kb = first.rag.createCollection({ name: 'NestJS' })
    const flow = first.workflows.create({ name: 'Daily NestJS Knowledge Base Refresh' })
    first.workflows.save(flow.id, { ...nestjsRefresh(kb.id), cron: '0 6 * * *', cronEnabled: true })
    const auto = first.workflows.createAutomation({ name: 'Already one', automation: { prompt: 'Hi', agentId: null, tools: [], servers: [], collectionIds: [], skills: [], watch: null, commands: null } })
    first.workflows.stopScheduler()
    first.ctx.db.close()

    const next = open(dataDir)
    const wf = next.workflows.get(flow.id)
    expect(wf.automation?.prompt).toMatch(/^This automation was converted from the flow “Daily NestJS Knowledge Base Refresh”\. Do these steps in order:\n\n1\. Search the web/)
    expect(wf.automation).toMatchObject({ agentId: null, collectionIds: [kb.id], watch: null, commands: null })
    expect(wf.automation?.tools.sort()).toEqual(['kb_ingest', 'web_fetch', 'web_search'])
    expect(wf).toMatchObject({ cron: '0 6 * * *', cronEnabled: true })
    expect(wf.nodes.map((n) => n.type)).toEqual(['trigger', 'agent', 'output'])
    expect(wf.nodes[1].data).toMatchObject({ automation: true, prompt: wf.automation?.prompt })
    expect(next.workflows.get(auto.id).automation?.prompt).toBe('Hi')

    const dir = join(dataDir, 'backups', 'flows')
    expect(existsSync(dir)).toBe(true)
    const backups = readdirSync(dir)
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(new RegExp(`^${flow.id}-\\d+\\.json$`))
    const row = JSON.parse(readFileSync(join(dir, backups[0]), 'utf8'))
    expect(row).toMatchObject({ id: flow.id, name: 'Daily NestJS Knowledge Base Refresh', cron: '0 6 * * *', cron_enabled: 1 })
    expect(JSON.parse(row.graph).nodes).toHaveLength(6)

    // Again: nothing left to convert, no new backups.
    expect(next.workflows.convertFlows()).toEqual([])
    expect(readdirSync(dir)).toHaveLength(1)
    next.workflows.stopScheduler()
    next.ctx.db.close()
  })

  it("leaves an exported app's graph alone when conversion is off (the runner)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cloth-convert-'))
    const first = open(dataDir)
    const kb = first.rag.createCollection({ name: 'NestJS' })
    const flow = first.workflows.create({ name: 'Exported' })
    first.workflows.save(flow.id, nestjsRefresh(kb.id))
    first.workflows.stopScheduler()
    first.ctx.db.close()

    const runner = createServices({ dataDir, secrets: plainSecrets, dbFile: join(dataDir, 'cloth.db'), sidecarsDir: join(REPO, 'sidecars'), examplesDir: join(REPO, 'resources', 'examples'), convertFlows: false })
    const wf = runner.workflows.get(flow.id)
    expect(wf.automation).toBeNull()
    expect(wf.nodes).toHaveLength(6)
    runner.workflows.stopScheduler()
    runner.ctx.db.close()
  })
})
