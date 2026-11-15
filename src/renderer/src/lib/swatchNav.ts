import { create } from 'zustand'
import { useApp } from './store'

/** The swatch the Swatches page shows (set when a chat's swatch card is opened). */
export const useSwatchNav = create<{ selected: string | null }>(() => ({ selected: null }))

export function openSwatch(id: string): void {
  useSwatchNav.setState({ selected: id })
  useApp.getState().setPage('swatches')
}
