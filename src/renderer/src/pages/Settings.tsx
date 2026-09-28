import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { AppInfo } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { Button, Card, Field, Input, PageHeader, Switch } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { Logo } from '@/components/Logo'
import { WebSearchSettings } from './WebSearchSettings'

export function SettingsPage() {
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [port, setPort] = useState('')
  useEffect(() => {
    void api.app.info().then(setInfo)
  }, [])
  useEffect(() => {
    if (settings) setPort(String(settings.mcpPort))
  }, [settings])
  if (!settings) return null

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title="Settings" />
      <div className="mx-auto max-w-3xl space-y-4 p-5">
        <Section title="Models">
          <Field label="Default chat model">
            <ModelPicker value={settings.defaultModel} onChange={(m) => void update({ defaultModel: m })} allowNone noneLabel="None" />
          </Field>
          <Field label="Default embedding model">
            <ModelPicker kind="embedding" value={settings.embeddingModel} onChange={(m) => void update({ embeddingModel: m })} allowNone noneLabel="None (BM25 only)" />
          </Field>
          <Field label="Default image model" hint="Used by generate_image in chat. Mark models as Image on the Models page.">
            <ModelPicker kind="image" value={settings.imageModel} onChange={(m) => void update({ imageModel: m })} allowNone noneLabel="First image model available" />
          </Field>
        </Section>

        <Section title="Chat" hint="When a conversation nears the model's context window, older turns are summarised into a checkpoint before the next message. The originals stay visible in the chat. You can also summarise any time from the context ring next to the send button.">
          <Switch checked={settings.autoCompact} onChange={(autoCompact) => void update({ autoCompact })} label="Summarise long conversations automatically" />
        </Section>

        <WebSearchSettings />

        <Section title="Chunking" hint="Applies to newly indexed documents. Re-index a document to re-chunk it.">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Chunk size (characters)">
              <Input type="number" min={300} max={8000} defaultValue={settings.chunkSize} onBlur={(e) => void update({ chunkSize: clamp(Number(e.target.value), 300, 8000) })} />
            </Field>
            <Field label="Overlap (characters)">
              <Input type="number" min={0} max={2000} defaultValue={settings.chunkOverlap} onBlur={(e) => void update({ chunkOverlap: clamp(Number(e.target.value), 0, 2000) })} />
            </Field>
          </div>
        </Section>

        <Section title="MCP server">
          <Field label="Port" hint="The server restarts when the port changes.">
            <div className="flex gap-2">
              <Input type="number" className="w-32" value={port} onChange={(e) => setPort(e.target.value)} />
              <Button disabled={Number(port) === settings.mcpPort || !(Number(port) > 1023 && Number(port) < 65536)} onClick={() => void update({ mcpPort: Number(port) })}>
                Apply
              </Button>
            </div>
          </Field>
        </Section>

        <Section title="Data">
          {info && (
            <div className="flex items-center gap-2">
              <span className="selectable min-w-0 flex-1 truncate font-mono text-[12px] text-muted">{info.dataDir}</span>
              <Button size="sm" icon={<FolderOpen size={12} />} onClick={() => void api.app.openPath(info.dataDir)}>
                Open
              </Button>
            </div>
          )}
          <div className="text-[11.5px] text-dim">Everything lives here: cloth.db (SQLite: providers, knowledge, chats, workflows), skills/ (the skill hub) and skills-trash/. API keys are encrypted with the OS keychain.</div>
        </Section>

        {info && (
          <Card className="flex items-center gap-3 p-4">
            <Logo size={28} />
            <div>
              <div className="text-[13px] font-semibold">Cloth {info.version}</div>
              <div className="text-[11.5px] text-dim">
                Electron {info.electron} · Node {info.node} · {info.platform} · agent runtime: pi-agent-core
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card className="space-y-3 p-4">
      <div>
        <div className="text-[13px] font-semibold">{title}</div>
        {hint && <div className="text-[11.5px] text-dim">{hint}</div>}
      </div>
      {children}
    </Card>
  )
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo))
}
