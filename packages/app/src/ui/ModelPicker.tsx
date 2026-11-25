import { useMemo, useState } from 'react'

export interface ModelOption {
  id: string
  name?: string
  description?: string
}

/**
 * Searchable list of a provider's (or harness's) models. Typing filters the list; an id that
 * isn't listed can still be used as typed.
 */
export function ModelPicker({
  models,
  value,
  onChange,
  loading,
  error,
  emptyLabel = 'Default model',
  allowDefault,
}: {
  models: ModelOption[]
  value: string
  onChange: (id: string) => void
  loading?: boolean
  error?: string
  /** Label of the "no model" choice, when `allowDefault`. */
  emptyLabel?: string
  /** Offer a choice that leaves the model unset, so the provider picks. */
  allowDefault?: boolean
}) {
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  const shown = useMemo(() => {
    const l = query ? models.filter((m) => m.id.toLowerCase().includes(query) || m.name?.toLowerCase().includes(query)) : models
    return l.slice(0, 200)
  }, [models, query])
  const total = query ? models.filter((m) => m.id.toLowerCase().includes(query) || m.name?.toLowerCase().includes(query)).length : models.length
  const exact = models.some((m) => m.id === q.trim())
  const current = models.find((m) => m.id === value)

  return (
    <div className="model-picker">
      <div className="model-current">
        <span className="muted">Selected:</span> <span className="mono">{value ? (current?.name && current.name !== value ? `${current.name} (${value})` : value) : emptyLabel}</span>
      </div>
      <input
        className="input"
        type="search"
        placeholder={loading ? 'Loading models…' : `Search ${models.length} model${models.length === 1 ? '' : 's'}`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          const pick = exact ? q.trim() : (shown[0]?.id ?? q.trim())
          if (pick) onChange(pick)
        }}
        aria-label="Search models"
      />
      <div className="list model-list" role="listbox" aria-label="Models">
        {allowDefault && !query && (
          <button type="button" role="option" aria-selected={!value} className={`list-item ${!value ? 'on' : ''}`} onClick={() => onChange('')}>
            <div className="main">
              <div className="t">{emptyLabel}</div>
            </div>
          </button>
        )}
        {shown.map((m) => (
          <button type="button" role="option" aria-selected={m.id === value} key={m.id} className={`list-item ${m.id === value ? 'on' : ''}`} onClick={() => onChange(m.id)}>
            <div className="main">
              <div className="t">{m.name && m.name !== m.id ? m.name : <span className="mono">{m.id}</span>}</div>
              {((m.name && m.name !== m.id) || m.description) && (
                <div className="s">{[m.name && m.name !== m.id ? m.id : '', m.description].filter(Boolean).join(' · ')}</div>
              )}
            </div>
          </button>
        ))}
        {q.trim() && !exact && (
          <button type="button" className="list-item" onClick={() => onChange(q.trim())}>
            <div className="main">
              <div className="t">
                Use “<span className="mono">{q.trim()}</span>”
              </div>
              <div className="s">A model id that isn’t listed</div>
            </div>
          </button>
        )}
        {!shown.length && !q.trim() && <div className="list-item muted">{loading ? 'Loading models…' : 'No models listed.'}</div>}
      </div>
      {total > shown.length && <div className="hint">Showing {shown.length} of {total}. Search to narrow it down.</div>}
      {error && <div className="hint">{error}</div>}
    </div>
  )
}
