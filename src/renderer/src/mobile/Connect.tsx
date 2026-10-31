import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ClipboardText, Desktop, QrCode, WifiHigh } from '@phosphor-icons/react'
import { Logo } from '@/components/Logo'
import { Spinner } from '@/components/ui'
import { forgetPairing, pairWith, useConnection } from './bridge'
import { canScan, scanQr } from './native'

const ENTER = { type: 'spring', stiffness: 260, damping: 28 } as const

/** First run (or after being unpaired): pair with the desktop by scanning its QR code or pasting the code. */
export function Connect() {
  const unpaired = useConnection((s) => s.state === 'unpaired')
  const reason = useConnection((s) => s.info?.error)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pasting, setPasting] = useState(!canScan)
  const [code, setCode] = useState('')

  const connect = async (text: string) => {
    setBusy(true)
    setError(null)
    try {
      if (unpaired) await forgetPairing()
      await pairWith(text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const scan = async () => {
    setError(null)
    try {
      const text = await scanQr()
      if (text) await connect(text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-bg px-6 pb-[calc(var(--safe-bottom)+24px)] pt-[calc(var(--safe-top)+56px)]">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={ENTER} className="flex flex-col items-center text-center">
        <div className="relative">
          <div className="absolute inset-0 -z-10 scale-150 rounded-full bg-crimson/20 blur-2xl" />
          <Logo size={56} />
        </div>
        <div className="mt-6 text-[24px] font-semibold tracking-tight">Cloth</div>
        <div className="mt-1.5 max-w-[300px] text-[14px] leading-relaxed text-dim">Your developer hub, from your phone. Your PC does the work — models, files and keys stay there.</div>
      </motion.div>

      {unpaired && (
        <div className="mt-8 rounded-[14px] border border-danger-line bg-danger-soft px-4 py-3 text-[13px] text-danger-hi">{reason || 'This phone was unpaired.'} Pair again to reconnect.</div>
      )}

      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...ENTER, delay: 0.08 }} className="mt-10 space-y-3 rounded-[20px] border border-line bg-panel p-5">
        <Step n={1} icon={<Desktop size={18} />}>
          On your PC, open Cloth → <b className="text-fg">Settings</b> → <b className="text-fg">Phone</b> → <b className="text-fg">Pair a phone</b>.
        </Step>
        <Step n={2} icon={<QrCode size={18} />}>
          Scan the code shown there.
        </Step>
        <Step n={3} icon={<WifiHigh size={18} />}>
          Stay on the same Wi-Fi — or use Tailscale on both to connect from anywhere.
        </Step>
      </motion.div>

      <div className="flex-1" />

      <AnimatePresence>
        {error && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-6 rounded-[14px] border border-danger-line bg-danger-soft px-4 py-3 text-[13px] text-danger-hi">
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-6 space-y-2.5">
        <AnimatePresence initial={false}>
          {pasting && (
            <motion.div key="paste" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <textarea
                value={code}
                onChange={(e) => setCode(e.target.value)}
                rows={3}
                placeholder="Paste the pairing code (cloth://pair?d=…)"
                className="mb-2.5 block w-full resize-none rounded-[14px] border border-line-strong bg-panel px-4 py-3 font-mono text-[12px] text-fg outline-none placeholder:text-dim focus:border-crimson-line"
              />
            </motion.div>
          )}
        </AnimatePresence>
        {pasting ? (
          <BigButton primary disabled={busy || !code.trim()} onClick={() => void connect(code)}>
            {busy ? <Spinner className="text-white" /> : null}
            {busy ? 'Connecting…' : 'Connect'}
          </BigButton>
        ) : (
          <BigButton primary disabled={busy} onClick={() => void scan()}>
            {busy ? <Spinner className="text-white" /> : <QrCode size={20} weight="bold" />}
            {busy ? 'Connecting…' : 'Scan pairing code'}
          </BigButton>
        )}
        {canScan && (
          <BigButton onClick={() => setPasting(!pasting)}>
            {pasting ? <QrCode size={18} /> : <ClipboardText size={18} />}
            {pasting ? 'Scan instead' : 'Paste code instead'}
          </BigButton>
        )}
      </div>
    </div>
  )
}

function Step({ n, icon, children }: { n: number; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3.5">
      <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-elev-2 text-crimson-hi">
        {icon}
        <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-crimson text-[9px] font-bold text-white">{n}</span>
      </div>
      <div className="pt-1.5 text-[13.5px] leading-snug text-muted">{children}</div>
    </div>
  )
}

function BigButton({ primary, disabled, onClick, children }: { primary?: boolean; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      disabled={disabled}
      onClick={onClick}
      className={
        primary
          ? 'flex h-[52px] w-full items-center justify-center gap-2 rounded-[14px] bg-crimson text-[15px] font-semibold text-white shadow-[0_8px_30px_-8px_rgb(220_38_69/0.6)] disabled:opacity-50'
          : 'flex h-[52px] w-full items-center justify-center gap-2 rounded-[14px] border border-line-strong text-[14px] font-medium text-muted'
      }
    >
      {children}
    </motion.button>
  )
}
