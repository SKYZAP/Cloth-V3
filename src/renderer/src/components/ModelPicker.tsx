import { useEffect } from 'react'
import type { ModelRef } from '@shared/types'
import { useApp } from '@/lib/store'
import { Select } from './ui'

const SEP = '::'

export function ModelPicker({
  value,
  onChange,
  kind = 'chat',
  allowNone,
  noneLabel = 'Default model',
  className
}: {
  value: ModelRef | null | undefined
  onChange(ref: ModelRef | null): void
  kind?: 'chat' | 'embedding'
  allowNone?: boolean
  noneLabel?: string
  className?: string
}) {
  const providers = useApp((s) => s.providers)
  const loadProviders = useApp((s) => s.loadProviders)
  useEffect(() => {
    if (!providers.length) void loadProviders()
  }, [providers.length, loadProviders])

  const enabled = providers.filter((p) => p.enabled)
  const current = value ? `${value.providerId}${SEP}${value.modelId}` : ''
  const known = enabled.some((p) => p.id === value?.providerId && p.models.some((m) => m.id === value?.modelId))
  const empty = !enabled.some((p) => p.models.some((m) => (kind === 'embedding' ? m.embedding : !m.embedding)))

  return (
    <Select
      className={className}
      value={current}
      onChange={(e) => {
        const v = e.target.value
        if (!v) return onChange(null)
        const [providerId, ...rest] = v.split(SEP)
        onChange({ providerId, modelId: rest.join(SEP) })
      }}
    >
      {(allowNone || !value) && <option value="">{allowNone ? noneLabel : empty ? 'No models — add a provider' : 'Select a model…'}</option>}
      {value && !known && <option value={current}>{value.modelId} (unavailable)</option>}
      {enabled.map((p) => {
        const models = p.models.filter((m) => (kind === 'embedding' ? m.embedding : !m.embedding))
        if (!models.length) return null
        return (
          <optgroup key={p.id} label={p.name}>
            {models.map((m) => (
              <option key={m.id} value={`${p.id}${SEP}${m.id}`}>
                {m.name !== m.id ? `${m.name} — ${m.id}` : m.id}
              </option>
            ))}
          </optgroup>
        )
      })}
    </Select>
  )
}
