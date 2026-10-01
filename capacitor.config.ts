import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'dev.cloth.mobile',
  appName: 'Cloth',
  webDir: 'out/mobile',
  backgroundColor: '#09090a',
  // The app talks to the desktop over plain ws:// on the LAN/Tailscale (frames are end-to-end encrypted).
  // Dev: CLOTH_MOBILE_DEV_URL (e.g. http://10.0.2.2:5190/mobile.html from `npm run mobile:dev`) at `cap sync`
  // makes the app load the live Vite server instead of the bundled files.
  server: { androidScheme: 'http', cleartext: true, ...(process.env.CLOTH_MOBILE_DEV_URL ? { url: process.env.CLOTH_MOBILE_DEV_URL } : {}) },
  android: { path: 'mobile/android' },
  plugins: {
    Keyboard: { resize: 'native' },
    SystemBars: { insetsHandling: 'css' }
  }
}

export default config
