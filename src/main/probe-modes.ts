// Dev-only probe (CLOTH_PROBE=modes): runs one feature request in an existing project in one of Cloth's modes, with a
// real model, answering as a hands-off person would (every question gets the agent's own recommendation, every
// approval is allowed, every stage gate is approved), and writes what it cost and did to report.json.
//   CLOTH_PROBE_MODE       chat | spec | openspec
//   CLOTH_PROBE_WORKSPACE  the project folder (a git repo)
//   CLOTH_PROBE_PROMPT     a file holding the request
//   CLOTH_PROBE_MODEL      a model id (or part of one) from the providers in CLOTH_HOME
//   CLOTH_PROBE_THINKING   effort (default medium)
//   CLOTH_PROBE_MINUTES    time limit (default 90)
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Services } from './services'
import type { QuestionRound, ThinkingLevel, UiBlock, UiMessage } from '@shared/types'
import { newOpenSpecRun } from './agent/openspec'
import { reviewStats } from './probe-specship'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Totals {
  replies: number
  input: number
  cached: number
  output: number
  cost: number
  agentRuns: number
  agentInput: number
  agentCached: number
  agentOutput: number
  agentCost: number
  toolCalls: number
  tools: Record<string, number>
}

function totals(messages: UiMessage[]): Totals {
  const t: Totals = { replies: 0, input: 0, cached: 0, output: 0, cost: 0, agentRuns: 0, agentInput: 0, agentCached: 0, agentOutput: 0, agentCost: 0, toolCalls: 0, tools: {} }
  const walk = (blocks: UiBlock[], nested: boolean) => {
    for (const b of blocks) {
      if (b.type !== 'tool') continue
      t.toolCalls++
      t.tools[b.trace.name] = (t.tools[b.trace.name] ?? 0) + 1
      const run = b.trace.subagent
      if (!run) continue
      t.agentRuns++
      t.agentInput += run.usage?.input ?? 0
      t.agentCached += run.usage?.cached ?? 0
      t.agentOutput += run.usage?.output ?? 0
      t.agentCost += run.usage?.cost ?? 0
      walk(run.blocks, true)
    }
    void nested
  }
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    t.replies++
    t.input += m.usage?.input ?? 0
    t.cached += m.usage?.cached ?? 0
    t.output += m.usage?.output ?? 0
    t.cost += m.usage?.cost ?? 0
    walk(m.blocks, false)
  }
  return t
}

const acceptAll = (round: QuestionRound) => round.questions.map((q, i) => `Q${i + 1} (${q.title}): yes, ${q.recommendation}`).join('\n')

export async function probeModes(s: Services, outDir: string, note: (m: string) => void): Promise<void> {
  const mode = (process.env.CLOTH_PROBE_MODE ?? 'chat') as 'chat' | 'spec' | 'openspec'
  const ws = process.env.CLOTH_PROBE_WORKSPACE
  const promptFile = process.env.CLOTH_PROBE_PROMPT
  if (!ws || !promptFile) throw new Error('Set CLOTH_PROBE_WORKSPACE and CLOTH_PROBE_PROMPT')
  const prompt = readFileSync(promptFile, 'utf8').trim()
  const want = process.env.CLOTH_PROBE_MODEL ?? 'gpt-6-luna'
  const provider = s.providers.list().find((p) => p.enabled && p.models.some((m) => m.id === want))
  if (!provider) throw new Error(`No provider has the model ${want}`)
  const model = { providerId: provider.id, modelId: want }
  const thinking = (process.env.CLOTH_PROBE_THINKING ?? 'medium') as ThinkingLevel
  // Titles are written by an extra model call; leave them out of the measurement.
  s.settings.update({ aiTitles: false })
  note(`mode ${mode}, model ${model.modelId} (${thinking}) via ${provider.name}, folder ${ws}`)

  const chat = s.chat.create({ model, workspace: ws, permissions: 'auto', subagents: true, webEnabled: false, knowledgeEnabled: false, mcpServers: [], thinking })
  const id = chat.id
  const t0 = Date.now()
  const events: string[] = []
  const log = (m: string) => {
    const line = `${((Date.now() - t0) / 1000).toFixed(0)}s ${m}`
    events.push(line)
    note(line)
  }

  if (mode === 'spec') await s.chat.startWorkflow(id, prompt)
  else {
    if (mode === 'openspec') s.chat.update(id, { openspec: newOpenSpecRun(false) })
    await s.chat.send(id, prompt)
  }
  log('started')

  const deadline = t0 + Number(process.env.CLOTH_PROBE_MINUTES ?? 90) * 60_000
  let nudges = 0
  let idle = 0
  let questions = 0
  let approvals = 0
  let gates = 0
  while (Date.now() < deadline) {
    await wait(1500)
    for (const q of s.chat.pendingQuestions(id)) {
      questions++
      log(`ask_user: ${q.question.slice(0, 140)} → ${q.options[0] ?? 'your recommendation'}`)
      s.chat.answerQuestion(q.id, q.options.length ? (q.multiple ? q.options.join(', ') : q.options[0]) : 'Go with your recommendation.')
    }
    for (const a of s.chat.pendingApprovals(id)) {
      approvals++
      log(`approval: ${a.kind} ${(a.command ?? a.path ?? '').slice(0, 100)} → allow`)
      s.chat.resolveApproval(a.id, 'allow')
    }
    if (s.chat.isRunning(id)) {
      idle = 0
      continue
    }
    if (++idle < 3) continue
    const session = s.chat.get(id)
    const last = s.chat.messages(id).at(-1)
    const traces = last?.role === 'assistant' ? last.blocks.flatMap((b) => (b.type === 'tool' ? [b.trace] : [])) : []
    if (mode === 'chat') {
      log('reply finished')
      break
    }
    if (mode === 'spec') {
      const w = session.workflow
      if (!w) break
      if (w.stage === 'done') {
        log('done')
        break
      }
      const round = traces.findLast((t) => t.questions)?.questions
      const gate = traces.findLast((t) => t.stageGate && t.status !== 'error')?.stageGate
      if (round && !gate) {
        questions += round.questions.length
        log(`round ${round.round}: ${round.questions.length} questions, accepting the recommendations`)
        await s.chat.send(id, acceptAll(round))
      } else if (gate) {
        gates++
        log(`gate ${gate.stage}: approving`)
        await s.chat.advanceWorkflow(id)
      } else if (nudges++ < 4) {
        log(`stage ${w.stage}: turn ended without a gate; nudging`)
        await s.chat.send(id, 'Carry on with this stage, then call finish_stage.')
      } else {
        log('gave up: no progress')
        break
      }
    } else {
      const run = session.openspec
      if (!run || run.step === 'done') {
        log(`done (${run?.step ?? 'mode left'})`)
        break
      }
      if (run.awaitingReview) {
        log('paused for review; replying')
        await s.chat.send(id, 'Looks good, go ahead.')
      } else if (nudges++ < 4) {
        log(`step ${run.step}: turn ended before done; nudging`)
        await s.chat.send(id, 'Carry on with the OpenSpec run until it is done.')
      } else {
        log('gave up: no progress')
        break
      }
    }
    idle = 0
  }
  if (Date.now() >= deadline) log('time limit reached')
  for (let i = 0; i < 40 && s.chat.isRunning(id); i++) await wait(1500)
  if (s.chat.isRunning(id)) {
    log('stopping the run')
    s.chat.abort(id)
    await wait(3000)
  }

  const messages = s.chat.messages(id)
  const session = s.chat.get(id)
  const last = messages.findLast((m) => m.role === 'assistant')
  const report = {
    mode,
    model,
    thinking,
    minutes: Math.round((Date.now() - t0) / 600) / 100,
    totals: totals(messages),
    questions,
    approvals,
    gates,
    nudges,
    events,
    workflow: session.workflow ?? null,
    openspec: session.openspec ?? null,
    review: mode === 'spec' ? reviewStats(messages) : null,
    finalReply: last ? last.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n') : ''
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(outDir, 'transcript.json'), JSON.stringify(messages, null, 2))
  const t = report.totals
  log(`report: ${t.input + t.cached + t.output + t.agentInput + t.agentCached + t.agentOutput} tokens, $${(t.cost + t.agentCost).toFixed(3)}`)
}
