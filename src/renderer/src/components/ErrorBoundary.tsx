import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ArrowClockwise, WarningCircle } from '@phosphor-icons/react'

/**
 * Catches a render crash in one part of the UI so the rest of the app keeps working, and offers a way
 * back instead of a blank window. `resetKey` changing (e.g. the page) clears the error.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: unknown; label?: string }, { error: Error | null; stack: string }> {
  state = { error: null as Error | null, stack: '' }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ stack: info.componentStack ?? '' })
    console.error(`[ui] ${this.props.label ?? 'view'} crashed:`, error, info.componentStack)
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, stack: '' })
  }

  render() {
    const { error, stack } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-lg rounded-[14px] border border-danger-line bg-panel p-5">
          <div className="flex items-center gap-2 text-[14px] font-semibold">
            <WarningCircle size={18} className="text-danger-hi" weight="fill" />
            This {this.props.label ?? 'view'} hit a problem
          </div>
          <div className="selectable mt-2 break-words font-mono text-[12px] text-danger-hi">{error.message}</div>
          {stack && (
            <details className="mt-2 text-[11px] text-dim">
              <summary className="cursor-default">Details</summary>
              <pre className="selectable mt-1 max-h-40 overflow-auto whitespace-pre-wrap">{stack.trim()}</pre>
            </details>
          )}
          <div className="mt-4 flex gap-2">
            <button onClick={() => this.setState({ error: null, stack: '' })} className="flex h-8 items-center gap-1.5 rounded-md bg-crimson px-3 text-[12.5px] font-medium text-white hover:bg-crimson-hi">
              <ArrowClockwise size={13} /> Try again
            </button>
            <button onClick={() => location.reload()} className="h-8 rounded-md border border-line px-3 text-[12.5px] text-muted hover:text-fg">
              Reload the window
            </button>
          </div>
        </div>
      </div>
    )
  }
}
