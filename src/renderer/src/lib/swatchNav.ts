import { create } from 'zustand'
import { useApp } from './store'
import { openSwatchesTab } from '@/pages/chat/setupNav'

interface SwatchNav {
  /** The swatch the Swatches page shows (set when a chat's swatch card is opened there). */
  selected: string | null
  /** The swatch the chat's side panel shows (its Swatches tab). */
  panel: string | null
  /** Whether that tab is on screen (a card says "Showing" only then). */
  panelVisible: boolean
  /** The swatch there was closed: the tab lists the chat's swatches instead of showing one. */
  panelClosed: boolean
}

export const useSwatchNav = create<SwatchNav>(() => ({ selected: null, panel: null, panelVisible: false, panelClosed: false }))

/** Open a swatch on the Swatches page. */
export function openSwatch(id: string): void {
  useSwatchNav.setState({ selected: id })
  useApp.getState().setPage('swatches')
}

/** Show a swatch in the chat's side panel, staying in the chat. */
export function openSwatchInPanel(id: string): void {
  useSwatchNav.setState({ panel: id, panelClosed: false })
  openSwatchesTab()
}

/** Show one of the chat's swatches in the Swatches tab already open. */
export function pickPanelSwatch(id: string): void {
  useSwatchNav.setState({ panel: id, panelClosed: false })
}

/** Close the swatch in the side panel, keeping the Swatches tab open. */
export function closePanelSwatch(): void {
  useSwatchNav.setState({ panelClosed: true })
}
