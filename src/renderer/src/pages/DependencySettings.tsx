import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { ArrowClockwise, ArrowSquareOut } from '@phosphor-icons/react'
import type { Dependency, DependencyReport } from '@shared/deps'
import { api } from '@/lib/api'
import { Badge, Button, Spinner } from '@/components/ui'

/*
 * Settings → Dependencies: what Cloth ships, and the programs it uses from this PC, each with what it's for.
 * The check runs a few short commands, so it happens when the section first opens and when asked again.
 */

const STATUS: Record<Dependency['status'], { dot: string; label: string }> = {
  ok: { dot: 'bg-ok', label: 'Found' },
  warn: { dot: 'bg-warn', label: 'Needs attention' },
  missing: { dot: 'bg-danger', label: 'Missing' }
}

export function DependencySettings() {
  const [report, setReport] = useState<DependencyReport | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    void api.deps.list().then(setReport)
  }, [])
  const refresh = async () => {
    setChecking(true)
    try {
      setReport(await api.deps.refresh())
    } finally {
      setChecking(false)
    }
  }
  if (!report)
    return (
      <div className="flex items-center gap-2 px-1 py-3 text-ui text-dim">
        <Spinner /> Checking what's installed…
      </div>
    )
  const bundled = report.items.filter((d) => d.source === 'bundled')
  const system = report.items.filter((d) => d.source === 'system')
  return (
    <>
      <DependencyGroup title="Shipped with Cloth" items={bundled} />
      <DependencyGroup title="On this PC" items={system} />
      <div className="flex items-center gap-3 px-1 text-caption text-dim">
        <span>Checked {new Date(report.checkedAt).toLocaleTimeString()}</span>
        <Button size="sm" icon={<ArrowClockwise size={13} className={clsx(checking && 'animate-spin')} />} onClick={() => void refresh()} disabled={checking}>
          Check again
        </Button>
      </div>
    </>
  )
}

function DependencyGroup({ title, items }: { title: string; items: Dependency[] }) {
  return (
    <section className="mb-6">
      <div className="mb-2 px-1 text-caption font-medium text-dim">{title}</div>
      <div className="divide-y divide-line overflow-hidden rounded-[10px] border border-line bg-panel p-1">
        {items.map((d) => (
          <DependencyRow key={d.id} dep={d} />
        ))}
      </div>
    </section>
  )
}

function DependencyRow({ dep: d }: { dep: Dependency }) {
  // A missing optional program isn't a problem: it reads as quiet, not red.
  const quiet = d.status === 'missing' && d.optional
  const st = STATUS[d.status]
  return (
    <div className="flex items-start gap-3 rounded-[7px] px-3 py-3">
      <span className={clsx('mt-[7px] h-2 w-2 shrink-0 rounded-full', quiet ? 'bg-line-strong' : st.dot)} title={quiet ? 'Not installed (optional)' : st.label} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-ui font-medium">
          {d.name}
          {d.version && <span className="font-mono text-caption font-normal text-dim">{d.version}</span>}
          {d.status === 'missing' && <Badge tone={quiet ? 'dim' : 'danger'}>{quiet ? 'Not installed' : 'Missing'}</Badge>}
          {d.status === 'warn' && <Badge tone="warn">Needs attention</Badge>}
        </div>
        <div className="mt-0.5 text-caption leading-relaxed text-muted">{d.usedFor}</div>
        {d.detail && <div className={clsx('mt-0.5 text-caption leading-relaxed', d.status === 'ok' || quiet ? 'text-dim' : 'text-warn')}>{d.detail}</div>}
      </div>
      {d.url && d.status !== 'ok' && (
        <Button size="sm" variant="ghost" icon={<ArrowSquareOut size={13} />} onClick={() => void api.app.openExternal(d.url!)}>
          {d.status === 'missing' ? 'Get it' : 'Help'}
        </Button>
      )}
    </div>
  )
}
