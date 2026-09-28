import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'dev.cloth.mobile',
  appName: 'Cloth',
  webDir: 'out/mobile',
  backgroundColor: '#09090a',
  // The app talks to the desktop over plain ws:// on the LAN/Tailscale (frames are end-to-end encrypted).
  server: { androidScheme: 'http', cleartext: true },
  android: { path: 'mobile/android' },
  plugins: {
    Keyboard: { resize: 'native' },
    SystemBars: { insetsHandling: 'css' }
  }
}

export default config
