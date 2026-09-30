import type { Collection, CustomTool, Skill, Workflow } from '@shared/types'
import type { ExportPlan } from '@shared/flow-bundle'

type Inventory = { tools: CustomTool[]; skills: Pick<Skill, 'name'>[]; collections: Pick<Collection, 'id' | 'name'>[] }

export function planExport(wf: Pick<Workflow, 'nodes'>, inv: Inventory): ExportPlan {
  const tools = new Set<string>()
  const skills = new Set<string>()
  const collections = new Set<string>()
  const errors: string[] = []
  const warnings: string[] = []
  let web = false
  const enabledTools = inv.tools.filter((t) => t.enabled).map((t) => t.name)
  const allSkills = inv.skills.map((s) => s.name)
  const allCollections = inv.collections.map((c) => c.id)
  const label = (n: Workflow['nodes'][number]) => `"${n.data.label || n.data.key}"`
  const addCollections = (ids: unknown) => {
    const list = Array.isArray(ids) ? (ids as string[]) : []
    for (const id of list.length ? list : allCollections) collections.add(id)
  }

  for (const n of wf.nodes) {
    const d = n.data
    switch (n.type) {
      case 'tool':
        if (!d.tool) errors.push(`Tool node ${label(n)} has no tool selected`)
        else tools.add(String(d.tool))
        break
      case 'skill':
        if (!d.skill) errors.push(`Skill node ${label(n)} has no skill selected`)
        else skills.add(String(d.skill))
        break
      case 'rag':
        addCollections(d.collectionIds)
        break
      case 'web':
        web = true
        break
      case 'agent':
        if (d.customTools !== false) for (const t of Array.isArray(d.tools) ? d.tools : enabledTools) tools.add(String(t))
        if (d.skillsEnabled !== false) for (const s of Array.isArray(d.skills) ? d.skills : allSkills) skills.add(String(s))
        if (d.webEnabled) web = true
        addCollections(d.collectionIds)
        if (d.workspace) warnings.push(`Agent ${label(n)} reads its own folder (${d.workspace}), which will not exist on other computers — it will use the app's workspace instead`)
        if (d.customTools !== false && !Array.isArray(d.tools) && enabledTools.length) warnings.push(`Agent ${label(n)} can use every enabled tool, so all ${enabledTools.length} are included — pick only the ones it needs in its settings`)
        if (d.skillsEnabled !== false && !Array.isArray(d.skills) && allSkills.length > 3) warnings.push(`Agent ${label(n)} can use every skill, so all ${allSkills.length} are included — pick only the ones it needs in its settings`)
        break
      case 'http':
        if (/localhost|127\.0\.0\.1/.test(String(d.url ?? ''))) warnings.push(`HTTP node ${label(n)} calls a local address, which other computers will not have`)
        break
    }
  }

  for (const name of tools) {
    const t = inv.tools.find((x) => x.name === name)
    if (!t) errors.push(`The flow uses the tool "${name}", which no longer exists`)
    else if (!t.enabled) errors.push(`The tool "${name}" is disabled — enable it on the Tools page or take it out of the flow`)
    else if (t.kind === 'command') warnings.push(`The tool "${name}" runs "${t.config.command}", which must be installed on the computer that runs the app`)
    else if (t.kind === 'http' && /localhost|127\.0\.0\.1/.test(String(t.config.url ?? ''))) warnings.push(`The tool "${name}" calls a local address, which other computers will not have`)
  }
  for (const name of skills) if (!allSkills.includes(name)) errors.push(`The flow uses the skill "${name}", which no longer exists`)
  for (const id of collections) if (!allCollections.includes(id)) errors.push(`The flow searches a knowledge collection that no longer exists (${id})`)

  return { tools: [...tools].sort(), skills: [...skills].sort(), collections: [...collections], web, errors, warnings }
}
