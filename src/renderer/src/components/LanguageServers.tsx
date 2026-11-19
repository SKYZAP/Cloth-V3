import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { ArrowSquareOut, CheckCircle, DownloadSimple, Warning } from '@phosphor-icons/react'
import { LANGUAGES, type LanguageId, type LanguageServerInfo } from '@shared/onboarding'
import { api, useEvent } from '@/lib/api'
import { attempt } from '@/lib/store'
import { Button, Spinner } from './ui'

type Progress = { text: string; fraction: number | null }

/** Language servers for some languages, with installs Cloth runs itself and their progress. */
export function useLanguageServers(ids: LanguageId[]) {
  const [servers, setServers] = useState<LanguageServerInfo[] | null>(null)
  const [busy, setBusy] = useState<Partial<Record<LanguageId, Progress>>>({})
  const key = ids.join(',')
  useEffect(() => {
    let live = true
    void api.onboarding.languageServers(ids).then((s) => live && setServers(s), () => live && setServers([]))
    return () => {
      live = false
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEvent('languageServers', (e) => setBusy((b) => (b[e.id] ? { ...b, [e.id]: { text: e.text, fraction: e.fraction } } : b)))
  const swap = (info: LanguageServerInfo) => setServers((list) => (list ?? []).map((s) => (s.id === info.id ? info : s)))
  const run = async (id: LanguageId, fn: () => Promise<LanguageServerInfo>, done: string) => {
    setBusy((b) => ({ ...b, [id]: { text: 'Starting', fraction: null } }))
    const info = await attempt(fn, done)
    setBusy(({ [id]: _gone, ...rest }) => rest)
    if (info) swap(info)
  }
  const name = (id: LanguageId) => LANGUAGES.find((l) => l.id === id)?.name ?? id
  return {
    servers,
    busy,
    install: (id: LanguageId) => run(id, () => api.onboarding.installLanguageServer(id), `${name(id)} code intelligence installed`),
    remove: (id: LanguageId) => run(id, () => api.onboarding.removeLanguageServer(id), `Removed Cloth’s copy of the ${name(id)} server`)
  }
}

export type LanguageServers = ReturnType<typeof useLanguageServers>

/** One language's server: where it stands, and Install / Update / Remove when Cloth can do that itself. */
export function LanguageServerStatus({ info, progress, onInstall, onRemove, compact }: { info: LanguageServerInfo | undefined; progress?: Progress; onInstall(): void; onRemove?(): void; compact?: boolean }) {
  if (!info) return <span className="text-caption text-dim">Checking…</span>
  if (progress)
    return (
      <span className="flex min-w-0 items-center gap-2 text-caption text-muted" role="status">
        <Spinner size={12} />
        <span className="truncate">{progress.text}{progress.fraction !== null && progress.fraction < 1 ? ` · ${Math.round(progress.fraction * 100)}%` : ''}</span>
      </span>
    )
  const needs = info.needs && (
    <button type="button" onClick={() => void api.app.openExternal(info.needs!.url)} className="inline-flex items-center gap-1 text-caption text-warn hover:underline">
      <Warning size={12} />
      Needs {info.needs.name}
      <ArrowSquareOut size={10} />
    </button>
  )
  const ok = (text: string) => (
    <span className="inline-flex min-w-0 items-center gap-1 text-caption text-ok">
      <CheckCircle size={13} weight="fill" className="shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  )
  if (info.status === 'bundled') return ok('Included with Cloth')
  if (info.status === 'none') return <span className="text-caption text-dim">No language server yet</span>
  if (info.status === 'installed')
    return (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {ok(`${info.program} installed${info.version && info.version !== 'latest' ? ` (${info.version})` : ''}`)}
        {needs}
        {!compact && (
          <>
            <Button size="sm" variant="ghost" onClick={onInstall}>Update</Button>
            {onRemove && <Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button>}
          </>
        )}
      </span>
    )
  if (info.status === 'found')
    return (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {ok(`${info.program} found on this PC`)}
        {needs}
      </span>
    )
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {info.installable ? (
        <Button size="sm" variant="outline" icon={<DownloadSimple size={13} />} onClick={onInstall}>
          Install {info.program}
        </Button>
      ) : (
        info.url && (
          <button type="button" onClick={() => void api.app.openExternal(info.url!)} className={clsx('inline-flex items-center gap-1 text-caption text-warn hover:underline')}>
            How to install {info.program} <ArrowSquareOut size={10} />
          </button>
        )
      )}
      {needs}
    </span>
  )
}
