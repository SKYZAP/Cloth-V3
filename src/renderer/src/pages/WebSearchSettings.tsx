import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Globe, Play, Power, Search } from 'lucide-react'
import type { WebEngine, WebSearchResult, WebStatus } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Badge, Button, Card, Dot, Field, Input, Segmented, Switch } from '@/components/ui'

export function WebSearchSettings() {
  const settings = useApp((s) => s.settings)!
  const update = useApp((s) => s.updateSettings)
  const [status, setStatus] = useState<WebStatus | null>(null)
  const [query, setQuery] = useState('sqlite fts5 bm25 ranking')
  const [result, setResult] = useState<WebSearchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [external, setExternal] = useState(settings.searxngUrl)
  const [obscuraPath, setObscuraPath] = useState(settings.obscuraPath)
  const refresh = () => void api.web.status().then(setStatus)
  useEffect(refresh, [settings.webEngine, settings.searxngUrl, settings.obscuraPath])
  useEvent('web', refresh)

  const test = async () => {
    setSearching(true)
    setError(null)
    setResult(null)
    try {
      setResult(await api.web.search(query))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setSearching(false)
    refresh()
  }

  return (
    <Card className="space-y-3 p-4">
      <div>
        <div className="text-[13px] font-semibold">Web search</div>
        <div className="text-[11.5px] text-dim">
          Powers the web_search / web_fetch tools, the Web search workflow node and MCP web_search. Both engines ship with Cloth.
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Segmented<WebEngine>
          value={settings.webEngine}
          onChange={(webEngine) => void update({ webEngine })}
          items={[
            { value: 'obscura', label: 'Obscura', title: 'Stealth headless browser scraping DuckDuckGo — instant start' },
            { value: 'searxng', label: 'SearXNG', title: 'Metasearch across many engines — bundled Python sidecar' }
          ]}
        />
        <span className="text-[11.5px] text-dim">Switching takes effect immediately.</span>
      </div>

      {status && (
        <div className="grid grid-cols-2 gap-3">
          <EngineCard
            active={settings.webEngine === 'obscura'}
            name="Obscura"
            ok={status.obscura.available}
            lines={[status.obscura.version ? `v${status.obscura.version}` : null, status.obscura.error, 'Headless browser: scrapes DuckDuckGo per search and renders pages for web_fetch.']}
          >
            <Field label="Custom binary (optional)">
              <div className="flex gap-1.5">
                <Input
                  className="font-mono text-[11.5px]"
                  placeholder="bundled"
                  value={obscuraPath}
                  onChange={(e) => setObscuraPath(e.target.value)}
                  onBlur={() => obscuraPath !== settings.obscuraPath && void update({ obscuraPath: obscuraPath.trim() })}
                />
                <Button
                  size="sm"
                  onClick={async () => {
                    const [f] = await api.app.pickPaths({ title: 'Obscura binary' })
                    if (f) {
                      setObscuraPath(f)
                      void update({ obscuraPath: f })
                    }
                  }}
                >
                  …
                </Button>
              </div>
            </Field>
          </EngineCard>
          <EngineCard
            active={settings.webEngine === 'searxng'}
            name="SearXNG"
            ok={!!status.searxng.external || status.searxng.bundled}
            busy={status.searxng.starting}
            lines={[
              status.searxng.external ? `external: ${status.searxng.external}` : status.searxng.bundled ? `bundled ${status.searxng.version ?? ''}` : 'not bundled in this build',
              status.searxng.external ? null : status.searxng.running ? `running on ${status.searxng.url}` : status.searxng.starting ? 'starting…' : 'stopped — starts on first search',
              status.searxng.error
            ]}
            actions={
              !status.searxng.external && status.searxng.bundled ? (
                status.searxng.running ? (
                  <Button size="sm" variant="ghost" icon={<Power size={11} />} onClick={() => void api.web.stopSearxng().then(setStatus)}>
                    Stop
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" icon={<Play size={11} />} loading={status.searxng.starting} onClick={() => void attempt(() => api.web.startSearxng()).then((s) => s && setStatus(s))}>
                    Start
                  </Button>
                )
              ) : null
            }
          >
            <Field label="External instance (optional)">
              <Input
                className="font-mono text-[11.5px]"
                placeholder="use bundled sidecar"
                value={external}
                onChange={(e) => setExternal(e.target.value)}
                onBlur={() => external !== settings.searxngUrl && void update({ searxngUrl: external.trim() })}
              />
            </Field>
          </EngineCard>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Results per search">
          <Input type="number" min={1} max={20} className="w-24" defaultValue={settings.webResults} onBlur={(e) => void update({ webResults: Math.max(1, Math.min(20, Number(e.target.value) || 6)) })} />
        </Field>
        <div className="pt-6">
          <Switch checked={settings.webAllowPrivate} onChange={(v) => void update({ webAllowPrivate: v })} label="Allow web_fetch to reach localhost / private network" />
        </div>
      </div>

      <div className="border-t border-line pt-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-2.5 top-2.5 text-dim" />
            <Input className="pl-7" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void test()} />
          </div>
          <Button icon={<Globe size={13} />} loading={searching} onClick={() => void test()}>
            Test search
          </Button>
        </div>
        {error && <div className="mt-2 rounded-md border border-crimson-line bg-crimson-soft px-3 py-2 text-[12px] text-crimson-hi">{error}</div>}
        {result && (
          <div className="mt-2 space-y-1.5">
            <div className="text-[11.5px] text-dim">
              {result.results.length} results from <b className="text-muted">{result.engine}</b> in {result.tookMs}ms
            </div>
            {result.results.map((r) => (
              <div key={r.url} className="rounded-md border border-line bg-bg px-3 py-2">
                <button className="text-left text-[12.5px] font-medium hover:text-crimson-hi" onClick={() => void api.app.openExternal(r.url)}>
                  {r.title}
                </button>
                <div className="truncate font-mono text-[10.5px] text-dim">{r.url}</div>
                {r.snippet && <div className="mt-0.5 line-clamp-2 text-[11.5px] text-muted">{r.snippet}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}

function EngineCard({
  active,
  name,
  ok,
  busy,
  lines,
  actions,
  children
}: {
  active: boolean
  name: string
  ok: boolean
  busy?: boolean
  lines: (string | null | undefined)[]
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className={clsx('space-y-2 rounded-lg border p-3', active ? 'border-crimson-line bg-crimson-soft' : 'border-line')}>
      <div className="flex items-center gap-2">
        <Dot tone={ok ? 'ok' : 'crimson'} pulse={busy} />
        <span className="text-[12.5px] font-semibold">{name}</span>
        {active && <Badge tone="crimson">active</Badge>}
        <div className="flex-1" />
        {actions}
      </div>
      {lines.filter(Boolean).map((l, i) => (
        <div key={i} className="text-[11.5px] text-dim">
          {l}
        </div>
      ))}
      {children}
    </div>
  )
}
