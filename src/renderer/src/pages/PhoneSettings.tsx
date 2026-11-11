import { useEffect, useState } from 'react'
import clsx from 'clsx'
import QRCode from 'qrcode'
import { motion } from 'motion/react'
import { CheckCircle, DeviceMobile, PencilSimple, Plus, WifiHigh } from '@phosphor-icons/react'
import type { RemoteHostAddress, RemotePairing, RemoteStatus } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { timeAgo } from '@/lib/format'
import { Badge, Button, Card, CopyButton, Field, Input, Modal, Switch, confirmAction } from '@/components/ui'

/** Settings → Phone: pair the Android app over home Wi-Fi or Tailscale, and manage paired phones. */
export function PhoneSettings() {
  const settings = useApp((s) => s.settings)!
  const update = useApp((s) => s.updateSettings)
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [pairing, setPairing] = useState<RemotePairing | null>(null)
  const [port, setPort] = useState(String(settings.remotePort))
  useEffect(() => void api.remote.status().then(setStatus), [])
  useEvent('remote', setStatus)

  const pair = async () => {
    const p = await attempt(() => api.remote.pair())
    if (p) setPairing(p)
    // Pairing switches the server on.
    void useApp.getState().loadSettings()
  }
  const revoke = async (id: string, name: string) => {
    if (!(await confirmAction(`${name} will be disconnected and will need to scan a new code to connect again.`, { title: 'Unpair this phone?', confirmLabel: 'Unpair', danger: true }))) return
    const s = await attempt(() => api.remote.revoke(id))
    if (s) setStatus(s)
  }
  const [editing, setEditing] = useState<string | null>(null)
  const rename = async (id: string, name: string) => {
    setEditing(null)
    if (name.trim()) setStatus(await api.remote.rename(id, name))
  }

  const devices = status?.devices.filter((d) => !d.pending) ?? []
  const tailscale = status?.hosts.some((h) => h.kind === 'tailscale')

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-ui text-muted">{devices.length ? `${devices.length} paired phone${devices.length > 1 ? 's' : ''}` : 'No phones paired yet'}</div>
        <Button variant="primary" icon={<Plus size={13} weight="bold" />} onClick={() => void pair()}>
          Pair a phone
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Switch checked={settings.remoteEnabled} onChange={(remoteEnabled) => void update({ remoteEnabled })} label="Allow phones to connect" />
        <Switch checked={settings.remoteKeepAwake} onChange={(remoteKeepAwake) => void update({ remoteKeepAwake })} label="Keep this PC awake while a phone is connected" />
      </div>

      {status && settings.remoteEnabled && (
        <div className="flex flex-wrap items-center gap-2 text-caption">
          <span className={clsx('h-1.5 w-1.5 rounded-full', status.running ? 'bg-ok' : 'bg-crimson')} />
          <span className={status.running ? 'text-muted' : 'text-danger-hi'}>{status.running ? `Listening on port ${status.port}` : (status.error ?? 'Not running')}</span>
          {reachable(status.hosts).map((h) => (
            <Badge key={h.address} tone={h.kind === 'tailscale' ? 'info' : 'neutral'} title={h.label}>
              <span className="font-mono">{h.address}</span>
              <span className="ml-1 text-dim">{h.label}</span>
            </Badge>
          ))}
          {!tailscale && <span className="text-dim">· Install Tailscale on both devices to connect away from home.</span>}
        </div>
      )}

      {devices.length > 0 && (
        <div className="divide-y divide-line rounded-lg border border-line">
          {devices.map((d) => (
            <div key={d.id} className="flex items-center gap-3 px-3 py-2.5">
              <DeviceMobile size={18} className={d.connected ? 'text-ok' : 'text-dim'} weight={d.connected ? 'fill' : 'regular'} />
              <div className="min-w-0 flex-1">
                {editing === d.id ? (
                  <Input
                    autoFocus
                    defaultValue={d.name}
                    className="h-7 w-56"
                    onBlur={(e) => void rename(d.id, e.target.value)}
                    onKeyDown={(e) => (e.key === 'Enter' ? e.currentTarget.blur() : e.key === 'Escape' && setEditing(null))}
                  />
                ) : (
                  <div className="flex items-center gap-2 text-ui font-medium">
                    {d.name}
                    <button onClick={() => setEditing(d.id)} className="text-dim hover:text-fg" aria-label="Rename">
                      <PencilSimple size={12} />
                    </button>
                  </div>
                )}
                <div className="text-caption text-dim">
                  {d.connected ? <span className="text-ok">Connected now</span> : `Last seen ${timeAgo(d.lastSeenAt)}`} · paired {timeAgo(d.createdAt)}
                </div>
              </div>
              <Button size="sm" variant="danger" onClick={() => void revoke(d.id, d.name)}>
                Unpair
              </Button>
            </div>
          ))}
        </div>
      )}

      <Field label="Port" hint="Phones paired earlier need a new code if you change it.">
        <div className="flex gap-2">
          <Input type="number" className="w-32" value={port} onChange={(e) => setPort(e.target.value)} />
          <Button disabled={Number(port) === settings.remotePort || !(Number(port) > 1023 && Number(port) < 65536)} onClick={() => void update({ remotePort: Number(port) })}>
            Apply
          </Button>
        </div>
      </Field>

      <PairModal pairing={pairing} status={status} onClose={() => setPairing(null)} />
    </Card>
  )
}

/** Wi-Fi/LAN and Tailscale addresses; virtual adapters (WSL, Hyper-V…) only when there's nothing else. The QR carries them all. */
function reachable(hosts: RemoteHostAddress[]): RemoteHostAddress[] {
  const good = hosts.filter((h) => h.kind !== 'other')
  return good.length ? good : hosts
}

function PairModal({ pairing, status, onClose }: { pairing: RemotePairing | null; status: RemoteStatus | null; onClose(): void }) {
  const [qr, setQr] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    setQr(null)
    if (pairing) void QRCode.toDataURL(pairing.link, { margin: 1, width: 560, errorCorrectionLevel: 'M', color: { dark: '#09090c', light: '#ffffff' } }).then(setQr)
  }, [pairing])
  useEffect(() => {
    if (!pairing) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pairing])

  const device = pairing ? status?.devices.find((d) => d.id === pairing.deviceId) : undefined
  const done = !!device && !device.pending
  const expired = !!pairing && !done && now > pairing.expiresAt
  const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0

  const close = () => {
    if (pairing && !done) void api.remote.cancelPairing(pairing.deviceId)
    onClose()
  }

  return (
    <Modal open={!!pairing} onClose={close} title="Pair a phone" width={520}>
      {done ? (
        <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center gap-2 py-8 text-center">
          <CheckCircle size={44} weight="fill" className="text-ok" />
          <div className="text-section font-semibold">{device!.name} is connected</div>
          <div className="text-ui text-dim">You can use Cloth from your phone now. Manage paired phones here in Settings.</div>
          <Button variant="primary" className="mt-3" onClick={onClose}>
            Done
          </Button>
        </motion.div>
      ) : (
        <div className="grid grid-cols-[220px_1fr] gap-5">
          <div className={clsx('relative aspect-square overflow-hidden rounded-[10px] bg-white p-2 transition-opacity', expired && 'opacity-20')}>
            {qr && <img src={qr} alt="Pairing QR code" className="h-full w-full [image-rendering:pixelated]" />}
          </div>
          <div className="space-y-3 text-ui">
            <ol className="list-decimal space-y-1.5 pl-4 text-muted">
              <li>Install the Cloth app on your Android phone.</li>
              <li>
                Tap <b className="text-fg">Scan pairing code</b> and point it at this code.
              </li>
              <li>Keep both on the same Wi-Fi — or on the same Tailscale network.</li>
            </ol>
            <div className="flex items-center gap-2 text-caption text-dim">
              <WifiHigh size={14} />
              {pairing?.hosts.length ? reachable(pairing.hosts).map((h) => `${h.address} (${h.label})`).join(' · ') : 'No network address found — connect this PC to Wi-Fi or Ethernet.'}
            </div>
            {expired ? (
              <div className="text-danger-hi">This code expired.</div>
            ) : (
              <div className="flex items-center gap-2 text-caption text-dim">
                <span className="pulse-crimson h-1.5 w-1.5 rounded-full bg-crimson" /> Waiting for your phone · code valid for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
              </div>
            )}
            <div className="flex gap-2 pt-1">
              {pairing && <CopyButton text={pairing.link} label="Copy code" />}
              <Button size="sm" variant="ghost" onClick={close}>
                Cancel
              </Button>
            </div>
            <div className="text-caption text-dim">No camera? Copy the code and paste it into the app.</div>
          </div>
        </div>
      )}
    </Modal>
  )
}
