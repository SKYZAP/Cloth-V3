import { useState } from 'react'
import clsx from 'clsx'
import { CheckCircle, Circle, Globe, Warning } from '@phosphor-icons/react'
import type { NetworkCheck } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { Button, Spinner } from './ui'

/*
 * Networks that inspect HTTPS (company proxies, some antivirus): what the network check found, and the fix when what
 * re-signs connections isn't trusted. Used by first-run setup (the Model step's notice, the Tools check's row) and
 * Settings → Network. The store is "Windows" or "the macOS Keychain", as the main process names it.
 */

const STATE: Record<NetworkCheck['state'], { label: string; tone: 'ok' | 'info' | 'warn' | 'neutral' }> = {
  direct: { label: 'Direct', tone: 'ok' },
  inspected: { label: 'Inspected, trusted', tone: 'info' },
  untrusted: { label: 'Needs a certificate', tone: 'warn' },
  offline: { label: 'Couldn’t check', tone: 'neutral' }
}

const TONE = { ok: 'border-ok/40 text-ok', info: 'border-info/40 text-info', warn: 'border-warn/40 text-warn', neutral: 'border-line text-dim' }

/** One line on what the check found, in the person's terms. */
export function networkSummary(check: NetworkCheck): string {
  switch (check.state) {
    case 'direct':
      return 'HTTPS reaches sites directly. Nothing to set up.'
    case 'inspected':
      return `HTTPS is checked by ${check.issuer ?? 'something on this network'}. Cloth trusts it, so connections work.`
    case 'untrusted':
      return `HTTPS is re-signed by ${check.issuer ?? 'something on this network'}, which Cloth doesn’t trust yet. Model providers, web search and MCP servers can’t connect until it does.`
    case 'offline':
      return 'Couldn’t reach the sites the check uses. You may be offline; try again once you’re connected.'
  }
}

export function NetworkPill({ check }: { check: NetworkCheck | null }) {
  if (!check) return <span className="inline-flex items-center gap-1 text-micro text-dim"><Spinner size={10} /> Checking…</span>
  const s = STATE[check.state]
  return <span className={clsx('inline-flex items-center rounded-full border px-2 text-micro font-medium whitespace-nowrap', TONE[s.tone])}>{s.label}</span>
}

/**
 * Trust what re-signs connections: the certificate of that name found in the system store when there is one, or a file
 * from IT. Saves it as the Settings → Network certificate, checks again and reports the new result.
 */
export function NetworkFix({ check, onChecked, onLater }: { check: NetworkCheck; onChecked(c: NetworkCheck): void; onLater?(): void }) {
  const updateSettings = useApp((s) => s.updateSettings)
  const [choice, setChoice] = useState<'system' | 'file'>(check.candidate ? 'system' : 'file')
  const [file, setFile] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pick = async () => {
    const [f] = await api.app.pickPaths({ title: 'Choose your network’s certificate (PEM)', filters: [{ name: 'Certificates', extensions: ['pem', 'crt', 'cer'] }, { name: 'All files', extensions: ['*'] }] })
    if (f) {
      setFile(f)
      setChoice('file')
      setError(null)
    }
  }
  const trust = async () => {
    setBusy(true)
    setError(null)
    try {
      if (choice === 'system' && check.candidate) {
        useApp.setState({ settings: await api.network.useSystemCertificate(check.candidate.fingerprint) })
      } else {
        const info = await api.app.certificateInfo(file)
        if ('error' in info) throw new Error(info.error)
        await updateSettings({ webCaCertPath: file })
      }
      const next = await api.network.check()
      if (next.state === 'untrusted') setError(`Cloth trusts that certificate now, but connections are still re-signed by ${next.issuer ?? 'something else'}. Ask IT for the certificate with that name.`)
      onChecked(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const option = (id: 'system' | 'file', title: string, detail: string) => (
    <label className={clsx('flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5', choice === id ? 'border-crimson-line bg-crimson-soft' : 'border-line bg-card hover:border-line-strong')}>
      <input type="radio" name="network-fix" className="mt-1 accent-crimson" checked={choice === id} onChange={() => (id === 'file' && !file ? void pick() : setChoice(id))} />
      <span className="flex min-w-0 flex-col">
        <span className="text-ui font-semibold text-fg">{title}</span>
        <span className="break-all text-caption text-dim">{detail}</span>
      </span>
    </label>
  )

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-bg p-3">
      {check.candidate && option('system', `Use “${check.candidate.subject}” from ${check.store}`, `Found in this computer’s certificates · valid until ${new Date(check.candidate.validTo).toLocaleDateString()}`)}
      {option('file', file ? 'Use this certificate file' : 'Choose a certificate file…', file || 'A .pem or .crt file from your IT team')}
      {error && (
        <span role="alert" className="text-caption text-danger-hi">
          {error}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" loading={busy} disabled={choice === 'file' && !file} onClick={() => void trust()}>
          Trust it
        </Button>
        {choice === 'file' && file && (
          <Button size="sm" variant="ghost" onClick={() => void pick()}>
            Choose another…
          </Button>
        )}
        {onLater && (
          <Button size="sm" variant="ghost" onClick={onLater}>
            Not now
          </Button>
        )}
      </div>
    </div>
  )
}

/** The notice above the Model step: only when connections are re-signed by something Cloth doesn't trust. */
export function NetworkNotice({ check, fixed, onChecked, onLater }: { check: NetworkCheck | null; fixed: boolean; onChecked(c: NetworkCheck): void; onLater(): void }) {
  if (check && fixed && check.state !== 'untrusted') {
    return (
      <div className="flex gap-2.5 rounded-lg border border-ok/35 bg-ok/[0.07] px-3 py-2.5 text-ui text-muted">
        <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-ok" />
        <span>
          <b className="font-semibold text-fg">Cloth trusts your network now.</b> {check.issuer ? `Connections re-signed by ${check.issuer} work. ` : ''}Change it any time in Settings → Network.
        </span>
      </div>
    )
  }
  if (check?.state !== 'untrusted') return null
  return (
    <div className="flex gap-2.5 rounded-lg border border-warn/35 bg-warn/[0.06] px-3 py-2.5 text-ui text-muted">
      <Warning size={16} className="mt-0.5 shrink-0 text-warn" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span>
          <b className="font-semibold text-fg">Your network inspects HTTPS.</b> Connections are re-signed by <b className="font-semibold text-fg">{check.issuer ?? 'an unknown certificate'}</b>, which Cloth doesn’t trust yet, so connecting a provider would fail.
          {!check.candidate && ' Ask your IT team for the network’s root certificate (a .pem or .crt file).'}
        </span>
        <NetworkFix check={check} onChecked={onChecked} onLater={onLater} />
      </div>
    </div>
  )
}

/** The network as a row in a list of checks (Tools check, Settings → Network), with the fix under it when needed. */
export function NetworkRow({ check, onChecked }: { check: NetworkCheck | null; onChecked(c: NetworkCheck): void }) {
  const Icon = !check ? Circle : check.state === 'untrusted' ? Warning : check.state === 'offline' ? Circle : check.state === 'direct' ? CheckCircle : Globe
  return (
    <div className="flex flex-col gap-2.5 border-t border-line bg-card px-3 py-2.5 first:border-t-0">
      <div className="flex items-center gap-3">
        <span className="shrink-0">
          <Icon size={16} weight={check?.state === 'direct' ? 'fill' : 'regular'} className={!check || check.state === 'offline' ? 'text-dim' : check.state === 'untrusted' ? 'text-warn' : check.state === 'direct' ? 'text-ok' : 'text-info'} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-ui font-semibold">Network</span>
          <span className="text-caption text-dim">{check ? networkSummary(check) : 'Checking how this computer reaches sites over HTTPS…'}</span>
        </div>
        <NetworkPill check={check} />
      </div>
      {check?.state === 'untrusted' && <NetworkFix check={check} onChecked={onChecked} />}
    </div>
  )
}
