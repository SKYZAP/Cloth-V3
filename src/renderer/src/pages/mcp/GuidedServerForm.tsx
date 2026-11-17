import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import clsx from 'clsx'
import { Eye, EyeSlash, Plus, X } from '@phosphor-icons/react'
import type { McpClientConfig } from '@shared/types'
import { serverProblem, splitCommandLine, suggestName, type McpServerEntry } from '@shared/mcp-config'
import { Button, Field, Input, Segmented } from '@/components/ui'

type Kind = 'http' | 'stdio'
type Row = { id: number; key: string; value: string }

let seq = 0
const rows = (m: Record<string, string> | undefined): Row[] => Object.entries(m ?? {}).map(([key, value]) => ({ id: ++seq, key, value }))
const toMap = (r: Row[]) => Object.fromEntries(r.filter((x) => x.key.trim() || x.value.trim()).map((x) => [x.key.trim(), x.value]))
const BEARER = /^Bearer\s+(.+)$/i

/** The form's state from a saved server (or empty): the Authorization bearer gets its own field. */
function fromConfig(c?: McpServerEntry) {
  const headers = { ...(c?.headers ?? {}) }
  const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization')
  const bearer = authKey ? BEARER.exec(headers[authKey])?.[1] : undefined
  if (authKey && bearer !== undefined) delete headers[authKey]
  return {
    kind: (c?.transport ?? 'http') as Kind,
    name: c?.name ?? '',
    url: c?.url ?? '',
    token: bearer ?? '',
    headers: rows(headers),
    command: c?.command ?? '',
    args: (c?.args ?? []).map((value) => ({ id: ++seq, key: '', value })),
    env: rows(c?.env)
  }
}

/**
 * A server filled in field by field: first how Cloth reaches it (a web address or a program it
 * starts), then just the fields that kind needs. Pasting a whole command line into Program splits it.
 */
export function GuidedServerForm({
  initial,
  prefill,
  focusToken,
  tokenHint,
  taken,
  onSave,
  onCancel
}: {
  initial?: McpClientConfig
  /** A new server started from a preset (a ready-made address and name). */
  prefill?: McpServerEntry
  /** Put the cursor in the access token box (a preset that needs one). */
  /** The server needs a token (a preset that asks for one): the box is required and gets the cursor. */
  focusToken?: boolean
  /** Where the token goes, when not the usual bearer header (Penpot puts its key in the address). */
  tokenHint?: string
  taken: string[]
  onSave(server: McpServerEntry): void
  onCancel?(): void
}) {
  const start = useMemo(() => fromConfig(initial ?? prefill), [initial, prefill])
  const [kind, setKind] = useState<Kind>(start.kind)
  const [name, setName] = useState(start.name)
  const [named, setNamed] = useState(!!initial || !!prefill)
  const [url, setUrl] = useState(start.url)
  const [token, setToken] = useState(start.token)
  const [showToken, setShowToken] = useState(false)
  const [headers, setHeaders] = useState<Row[]>(start.headers)
  const [command, setCommand] = useState(start.command)
  const [args, setArgs] = useState<Row[]>(start.args)
  const [env, setEnv] = useState<Row[]>(start.env)
  // Follow changes made elsewhere (another window, the phone, an import).
  useEffect(() => resetTo(start), [start])

  const entry: McpServerEntry =
    kind === 'http'
      ? { name: name.trim(), transport: 'http', url: url.trim(), headers: { ...toMap(headers), ...(token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}) }, command: '', args: [], env: {} }
      : { name: name.trim(), transport: 'stdio', command: command.trim(), args: args.map((a) => a.value).filter((a) => a.trim()), env: toMap(env) }
  // Until the name is typed, it follows what the server runs or where it is.
  useEffect(() => {
    if (!named) setName(suggestName(entry))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [named, kind, url, command, args])

  const problem = serverProblem(entry, taken)
  // A server that needs a token can't be added without one (the button waits; nothing turns red).
  const tokenMissing = !!focusToken && kind === 'http' && !token.trim()
  // The side panel slides in and takes focus as it opens; move it to the token box once it has.
  const tokenBox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!focusToken) return
    const t = setTimeout(() => tokenBox.current?.focus(), 350)
    return () => clearTimeout(t)
  }, [focusToken])
  const dirty = !initial || JSON.stringify(entry) !== JSON.stringify({ ...fromConfigEntry(initial) })
  const touched = kind === 'http' ? !!url.trim() : !!command.trim()

  const pasteCommand = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    if (!/\s/.test(text.trim())) return
    e.preventDefault()
    const split = splitCommandLine(text)
    setCommand(split.command)
    setArgs(split.args.map((value) => ({ id: ++seq, key: '', value })))
  }

  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid justify-items-start gap-1.5">
        <span className="text-caption font-medium text-muted">How Cloth reaches it</span>
        <Segmented
          value={kind}
          onChange={setKind}
          items={[
            { value: 'http', label: 'Web address', title: 'A server already running somewhere, reached over HTTP' },
            { value: 'stdio', label: 'Program', title: 'A program Cloth starts on this computer, like npx …' }
          ]}
        />
      </div>

      {kind === 'http' ? (
        <>
          <Field label="Address">
            <Input type="url" inputMode="url" spellCheck={false} autoComplete="off" placeholder="http://localhost:4401/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field label={focusToken ? 'Access token' : 'Access token (optional)'} hint={tokenHint ?? 'Sent as a Bearer token. Leave it empty for servers that sign in through the browser (Datadog, Linear, Notion…): Cloth asks you to sign in when it connects.'}>
            <div className="relative">
              <Input ref={tokenBox} type={showToken ? 'text' : 'password'} spellCheck={false} autoComplete="off" placeholder={focusToken ? 'Paste its access token' : 'Paste a token if the server needs one'} value={token} onChange={(e) => setToken(e.target.value)} className="pr-9" />
              <button
                type="button"
                onClick={() => setShowToken((s) => !s)}
                aria-label={showToken ? 'Hide token' : 'Show token'}
                className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-dim hover:bg-elev-2 hover:text-fg"
              >
                {showToken ? <EyeSlash size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </Field>
          <Pairs label="Other headers" add="Add a header" keyHolder="Header" valueHolder="Value" items={headers} onChange={setHeaders} />
        </>
      ) : (
        <>
          <Field label="Program" hint="Paste a whole command to split it.">
            <Input spellCheck={false} autoComplete="off" placeholder="npx" value={command} onChange={(e) => setCommand(e.target.value)} onPaste={pasteCommand} className="font-mono" />
          </Field>
          <div className="grid gap-1.5">
            <span className="text-caption font-medium text-muted">Arguments</span>
            {args.map((a, i) => (
              <div key={a.id} className="flex items-center gap-1.5">
                <span className="w-5 shrink-0 text-right text-caption tabular-nums text-dim">{i + 1}</span>
                <Input
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={`Argument ${i + 1}`}
                  value={a.value}
                  onChange={(e) => setArgs(args.map((x) => (x.id === a.id ? { ...x, value: e.target.value } : x)))}
                  className="font-mono"
                />
                <RemoveButton label={`Remove argument ${i + 1}`} onClick={() => setArgs(args.filter((x) => x.id !== a.id))} />
              </div>
            ))}
            <AddButton onClick={() => setArgs([...args, { id: ++seq, key: '', value: '' }])}>Add an argument</AddButton>
          </div>
          <Pairs label="Environment variables" add="Add a variable" keyHolder="NAME" valueHolder="Value" items={env} onChange={setEnv} secret />
        </>
      )}

      <Field label="Name">
        <Input
          spellCheck={false}
          autoComplete="off"
          placeholder="my-server"
          value={name}
          onChange={(e) => {
            setNamed(true)
            setName(e.target.value)
          }}
        />
      </Field>

      <div aria-live="polite" className="min-h-4 text-caption">
        {problem && touched ? <span className="text-danger-hi">{problem}</span> : touched && !problem ? <span className="break-all font-mono text-dim">{kind === 'http' ? (entry.url ?? '').replace(/([?&](?:userToken|token|key|api_key)=)[^&]+/i, '$1…') : [entry.command, ...entry.args].join(' ')}</span> : null}
      </div>

      {dirty && (
        <div className="flex justify-end gap-2">
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {initial && (
            <Button size="sm" variant="ghost" onClick={() => resetTo(start)}>
              Undo changes
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!!problem || tokenMissing} title={tokenMissing ? 'Paste its access token first' : undefined} onClick={() => onSave(entry)}>
            {initial ? 'Save' : 'Add server'}
          </Button>
        </div>
      )}
    </div>
  )

  function resetTo(s: ReturnType<typeof fromConfig>) {
    setKind(s.kind), setName(s.name), setUrl(s.url), setToken(s.token), setHeaders(s.headers), setCommand(s.command), setArgs(s.args), setEnv(s.env)
  }
}

/** A saved server in the shape the form produces, to tell whether anything changed. */
function fromConfigEntry(c: McpClientConfig): McpServerEntry {
  return c.transport === 'http'
    ? { name: c.name, transport: 'http', url: c.url ?? '', headers: c.headers ?? {}, command: '', args: [], env: {} }
    : { name: c.name, transport: 'stdio', command: c.command, args: c.args, env: c.env ?? {} }
}

function Pairs({ label, add, keyHolder, valueHolder, items, onChange, secret }: { label: string; add: string; keyHolder: string; valueHolder: string; items: Row[]; onChange(r: Row[]): void; secret?: boolean }) {
  const set = (id: number, patch: Partial<Row>) => onChange(items.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  return (
    <div className="grid gap-1.5">
      <span className="text-caption font-medium text-muted">{label}</span>
      {items.map((r) => (
        <div key={r.id} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_24px] items-center gap-1.5">
          <Input spellCheck={false} autoComplete="off" aria-label={`${label}: name`} placeholder={keyHolder} value={r.key} onChange={(e) => set(r.id, { key: e.target.value })} className="font-mono" />
          <Input spellCheck={false} autoComplete="off" type={secret ? 'password' : 'text'} aria-label={`${label}: value for ${r.key || 'new'}`} placeholder={valueHolder} value={r.value} onChange={(e) => set(r.id, { value: e.target.value })} className={clsx(!secret && 'font-mono')} />
          <RemoveButton label={`Remove ${r.key || 'row'}`} onClick={() => onChange(items.filter((x) => x.id !== r.id))} />
        </div>
      ))}
      <AddButton onClick={() => onChange([...items, { id: ++seq, key: '', value: '' }])}>{add}</AddButton>
    </div>
  )
}

function AddButton({ onClick, children }: { onClick(): void; children: string }) {
  return (
    <button type="button" onClick={onClick} className="flex h-7 w-fit items-center gap-1.5 rounded-md px-2 text-caption text-muted hover:bg-elev-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-crimson-hi">
      <Plus size={12} weight="bold" aria-hidden="true" />
      {children}
    </button>
  )
}

function RemoveButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title="Remove" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dim hover:bg-elev-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-crimson-hi">
      <X size={13} />
    </button>
  )
}
