// Cloth's UI components read `window.cloth` (phone vs desktop) when they load. The runner is
// always a desktop window with no Cloth backend: give them an inert bridge. Import this first.
;(window as unknown as { cloth: unknown }).cloth = {
  remote: false,
  platform: 'win32',
  invoke: async () => ({ ok: false, error: 'Not available in exported apps' }),
  onEvent: () => () => undefined
}
export {}
