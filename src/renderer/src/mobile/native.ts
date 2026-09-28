import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { Preferences } from '@capacitor/preferences'
import { Browser } from '@capacitor/browser'
import { Share } from '@capacitor/share'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { StatusBar, Style } from '@capacitor/status-bar'
import { Device } from '@capacitor/device'
import { BarcodeScanner, BarcodeFormat } from '@capacitor-mlkit/barcode-scanning'
import { Keyboard } from '@capacitor/keyboard'

/** Thin wrappers over Capacitor plugins, with browser fallbacks so the phone UI also runs in a desktop browser for development. */
export const native = Capacitor.isNativePlatform()

export async function getPref(key: string): Promise<string | null> {
  if (!native) {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }
  return (await Preferences.get({ key })).value
}

export async function setPref(key: string, value: string | null): Promise<void> {
  if (!native) {
    try {
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    } catch {
      /* storage unavailable */
    }
    return
  }
  if (value === null) await Preferences.remove({ key })
  else await Preferences.set({ key, value })
}

export async function deviceName(): Promise<string> {
  if (!native) return 'Browser'
  try {
    const info = await Device.getInfo()
    return info.name || [info.manufacturer, info.model].filter(Boolean).join(' ') || 'Android phone'
  } catch {
    return 'Android phone'
  }
}

export const canScan = native

/** Google's code scanner: no camera permission needed, returns the QR text or null if cancelled. */
export async function scanQr(): Promise<string | null> {
  const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()
  if (!available) {
    await BarcodeScanner.installGoogleBarcodeScannerModule()
    throw new Error('Installing the scanner from Google Play — try again in a moment, or paste the code instead.')
  }
  try {
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] })
    return barcodes[0]?.rawValue ?? null
  } catch (err) {
    if (/cancel/i.test(String(err))) return null
    throw err
  }
}

export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//.test(url)) return
  if (native) await Browser.open({ url, toolbarColor: '#0a0a0b' })
  else window.open(url, '_blank', 'noopener')
}

/** Hands an image to Android's share sheet (save to Photos/Files, send, …). */
export async function shareImage(base64: string, mime: string, name: string): Promise<void> {
  if (!native) {
    const a = document.createElement('a')
    a.href = `data:${mime};base64,${base64}`
    a.download = name
    a.click()
    return
  }
  const file = await Filesystem.writeFile({ path: name, data: base64, directory: Directory.Cache })
  await Share.share({ title: 'Cloth image', files: [file.uri], dialogTitle: 'Save or share image' })
}

export function onBackButton(handler: () => void): () => void {
  if (!native) return () => {}
  const sub = App.addListener('backButton', handler)
  return () => void sub.then((s) => s.remove())
}

export function onResume(handler: () => void): () => void {
  if (!native) {
    const fn = () => document.visibilityState === 'visible' && handler()
    document.addEventListener('visibilitychange', fn)
    return () => document.removeEventListener('visibilitychange', fn)
  }
  const sub = App.addListener('resume', handler)
  return () => void sub.then((s) => s.remove())
}

/** Soft keyboard shown/hidden (the tab bar steps aside while typing). */
export function onKeyboard(handler: (open: boolean) => void): () => void {
  if (!native) return () => {}
  const subs = [Keyboard.addListener('keyboardWillShow', () => handler(true)), Keyboard.addListener('keyboardWillHide', () => handler(false))]
  return () => subs.forEach((s) => void s.then((x) => x.remove()))
}

export function exitApp(): void {
  if (native) void App.minimizeApp()
}

export async function styleSystemBars(): Promise<void> {
  if (!native) return
  try {
    await StatusBar.setStyle({ style: Style.Dark })
    await StatusBar.setBackgroundColor({ color: '#0a0a0b' })
  } catch {
    /* edge-to-edge devices ignore this */
  }
}
