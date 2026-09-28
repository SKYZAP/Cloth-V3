import clsx from 'clsx'

/** Unified diff with coloured +/- lines and old/new line numbers. */
export function DiffView({ diff, maxHeight = 320 }: { diff: string; maxHeight?: number }) {
  const rows: { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'; text: string; a?: number; b?: number }[] = []
  let a = 0
  let b = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h) {
      a = Number(h[1])
      b = Number(h[2])
      rows.push({ kind: 'hunk', text: line })
    } else if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1), b: b++ })
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line.slice(1), a: a++ })
    else if (line.startsWith('…') || line.startsWith('\\')) rows.push({ kind: 'meta', text: line })
    else if (line.length || rows.length) rows.push({ kind: 'ctx', text: line.slice(1), a: a++, b: b++ })
  }
  return (
    <div className="selectable overflow-auto rounded-lg border border-line bg-bg font-mono text-[11px] leading-[1.55]" style={{ maxHeight }}>
      <table className="w-full border-collapse">
        <tbody>
          {rows.map((r, i) =>
            r.kind === 'hunk' || r.kind === 'meta' ? (
              <tr key={i} className="bg-elev/60">
                <td colSpan={3} className="px-2 py-0.5 text-[10.5px] text-dim">
                  {r.text}
                </td>
              </tr>
            ) : (
              <tr key={i} className={clsx(r.kind === 'add' && 'bg-ok/[0.08]', r.kind === 'del' && 'bg-crimson/[0.09]')}>
                <td className="w-9 select-none border-r border-line/60 px-1.5 text-right text-[10px] text-dim/70">{r.a ?? ''}</td>
                <td className="w-9 select-none border-r border-line/60 px-1.5 text-right text-[10px] text-dim/70">{r.b ?? ''}</td>
                <td className={clsx('whitespace-pre px-2', r.kind === 'add' ? 'text-ok' : r.kind === 'del' ? 'text-crimson-hi' : 'text-muted')}>
                  <span className="mr-1.5 select-none opacity-60">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
                  {r.text}
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>
    </div>
  )
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono text-[10.5px]">
      <span className="text-ok">+{added}</span> <span className="text-crimson-hi">−{removed}</span>
    </span>
  )
}
