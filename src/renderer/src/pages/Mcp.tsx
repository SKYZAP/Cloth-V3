import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Cable, Check, Copy, KeyRound, RotateCw } from 'lucide-react'
import type { McpStatus } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { duration, preview, timeAgo } from '@/lib/format'
import { Badge, Button, Card, Dot, PageHeader, Segmented, Switch } from '@/components/ui'
import { ExternalServers } from './mcp/ExternalServers'

type Client = 'claude-code' | 'cursor' | 'claude-desktop' | 'curl'

export function McpPage() {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [client, setClient] = useState<Client>('claude-code')
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  useEffect(() => {
    void api.mcp.status().then(setStatus)
  }, [])
  useEvent('mcp', setStatus)
  if (!status || !settings) return null

  const auth = status.requireToken ? { Authorization: `Bearer ${status.token}` } : undefined
  const snippets: Record<Client, string> = {
    'claude-code': `claude mcp add --transport http cloth ${status.url}${status.requireToken ? ` --header "Authorization: Bearer ${status.token}"` : ''}`,
    cursor: JSON.stringify({ mcpServers: { cloth: { url: status.url, ...(auth ? { headers: auth } : {}) } } }, null, 2),
    'claude-desktop': JSON.stringify(
      { mcpServers: { cloth: { command: 'npx', args: ['-y', 'mcp-remote', status.url, ...(auth ? ['--header', `Authorization:Bearer ${status.token}`] : [])] } } },
      null,
      2
    ),
    curl: `curl -s ${status.url} \\\n  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \\\n${status.requireToken ? `  -H "Authorization: Bearer ${status.token}" \\\n` : ''}  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"rag_search","arguments":{"query":"getting started"}}}'`
  }

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="MCP server"
        subtitle="Expose your skill hub and knowledge base to any MCP client — Claude Code, Cursor, Claude Desktop, other agents."
        actions={
          <>
            <Switch checked={settings.mcpEnabled} onChange={(v) => void updateSettings({ mcpEnabled: v })} label="Enabled" />
            <Button icon={<RotateCw size={13} />} onClick={() => void attempt(() => api.mcp.restart()).then((s) => s && setStatus(s))}>
              Restart
            </Button>
          </>
        }
      />
      <div className="grid gap-4 p-5 xl:grid-cols-[1fr_1fr] mobile:gap-3 mobile:p-3">
        <ExternalServers />
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className={clsx('flex h-10 w-10 items-center justify-center rounded-xl border', status.running ? 'border-ok/30 bg-ok/10 text-ok' : 'border-crimson-line bg-crimson-soft text-crimson-hi')}>
              <Cable size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                {status.running ? 'Running' : 'Stopped'}
                <Badge tone="dim">Streamable HTTP · stateless</Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="selectable truncate font-mono text-[12px] text-muted">{status.url}</span>
                <CopyIcon text={status.url} />
              </div>
            </div>
          </div>
          {status.error && <div className="mt-3 rounded-md border border-crimson-line bg-crimson-soft px-3 py-2 text-[12px] text-crimson-hi">{status.error}</div>}
          <div className="mt-4 space-y-3 border-t border-line pt-4">
            <div className="flex items-center justify-between">
              <Switch checked={settings.mcpRequireToken} onChange={(v) => void updateSettings({ mcpRequireToken: v })} label="Require bearer token" />
              <Button size="sm" variant="ghost" icon={<KeyRound size={12} />} onClick={() => void api.mcp.rotateToken().then(setStatus)}>
                Rotate token
              </Button>
            </div>
            {status.requireToken && (
              <div className="flex items-center gap-2 rounded-md border border-line bg-bg px-2.5 py-1.5">
                <span className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{status.token}</span>
                <CopyIcon text={status.token} />
              </div>
            )}
            <div className="text-[11.5px] text-dim">Bound to 127.0.0.1 only. Requests from browser origins other than localhost are rejected.</div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-3 text-[13px] font-semibold">Tools</div>
          <div className="space-y-2">
            {status.tools.map((t) => (
              <div key={t.name} className="flex gap-3">
                <span className="w-32 shrink-0 font-mono text-[12px] text-crimson-hi">{t.name}</span>
                <span className="text-[12px] text-muted">{t.description}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-4 xl:col-span-2">
          <div className="mb-3 flex items-center justify-between mobile:flex-wrap mobile:gap-2">
            <div className="text-[13px] font-semibold">Connect a client</div>
            <Segmented
              value={client}
              onChange={setClient}
              items={[
                { value: 'claude-code', label: 'Claude Code' },
                { value: 'cursor', label: 'Cursor' },
                { value: 'claude-desktop', label: 'Claude Desktop' },
                { value: 'curl', label: 'curl' }
              ]}
            />
          </div>
          <div className="relative">
            <pre className="selectable overflow-x-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11.5px] leading-relaxed text-muted">{snippets[client]}</pre>
            <div className="absolute right-2 top-2">
              <CopyIcon text={snippets[client]} />
            </div>
          </div>
          <div className="mt-2 text-[11.5px] text-dim">
            {client === 'cursor' && 'Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project).'}
            {client === 'claude-desktop' && 'Claude Desktop speaks stdio, so this bridges through mcp-remote. Add to claude_desktop_config.json.'}
            {client === 'claude-code' && 'Run once in a terminal; add --scope user to make it available in every project.'}
            {client === 'curl' && 'Raw JSON-RPC — handy for scripting and debugging.'}
          </div>
        </Card>

        <Card className="xl:col-span-2">
          <div className="border-b border-line px-4 py-2.5 text-[13px] font-semibold">Recent calls</div>
          {!status.recent.length ? (
            <div className="p-4 text-[12px] text-dim">No calls yet.</div>
          ) : (
            <table className="w-full text-[12px]">
              <tbody>
                {status.recent.map((c, i) => (
                  <tr key={i} className="border-t border-line first:border-0">
                    <td className="w-8 px-4 py-1.5">
                      <Dot tone={c.ok ? 'ok' : 'crimson'} />
                    </td>
                    <td className="w-36 py-1.5 font-mono text-[11.5px]">{c.tool}</td>
                    <td className="max-w-0 truncate py-1.5 font-mono text-[11px] text-dim" title={c.error}>
                      {c.error ?? preview(c.args, 140)}
                    </td>
                    <td className="w-20 py-1.5 text-right font-mono text-[11px] text-dim">{duration(c.durationMs)}</td>
                    <td className="w-24 px-4 py-1.5 text-right text-[11px] text-dim">{timeAgo(c.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  )
}

function CopyIcon({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="flex h-6 w-6 items-center justify-center rounded border border-line bg-elev text-dim hover:text-fg"
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
    </button>
  )
}
