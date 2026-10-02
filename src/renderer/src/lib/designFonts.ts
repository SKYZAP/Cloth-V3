// Open fonts the Design preview can show exactly (Latin subset only, loaded the first time a design uses them).
import inter from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import geist from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url'
import geistMono from '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url'
import manrope from '@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2?url'
import dmSans from '@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2?url'
import jakarta from '@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2?url'
import sourceSans from '@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-normal.woff2?url'
import nunitoSans from '@fontsource-variable/nunito-sans/files/nunito-sans-latin-wght-normal.woff2?url'
import workSans from '@fontsource-variable/work-sans/files/work-sans-latin-wght-normal.woff2?url'
import spaceGrotesk from '@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2?url'
import sora from '@fontsource-variable/sora/files/sora-latin-wght-normal.woff2?url'
import outfit from '@fontsource-variable/outfit/files/outfit-latin-wght-normal.woff2?url'
import fraunces from '@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2?url'
import playfair from '@fontsource-variable/playfair-display/files/playfair-display-latin-wght-normal.woff2?url'
import jetbrains from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url'
import firaCode from '@fontsource-variable/fira-code/files/fira-code-latin-wght-normal.woff2?url'
import sourceCode from '@fontsource-variable/source-code-pro/files/source-code-pro-latin-wght-normal.woff2?url'
import plexSans400 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2?url'
import plexSans500 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2?url'
import plexSans600 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2?url'
import plexSans700 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-700-normal.woff2?url'
import plexSerif400 from '@fontsource/ibm-plex-serif/files/ibm-plex-serif-latin-400-normal.woff2?url'
import plexSerif500 from '@fontsource/ibm-plex-serif/files/ibm-plex-serif-latin-500-normal.woff2?url'
import plexSerif600 from '@fontsource/ibm-plex-serif/files/ibm-plex-serif-latin-600-normal.woff2?url'
import plexSerif700 from '@fontsource/ibm-plex-serif/files/ibm-plex-serif-latin-700-normal.woff2?url'
import plexMono400 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?url'
import plexMono500 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2?url'
import plexMono600 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2?url'
import plexMono700 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-normal.woff2?url'

/** One variable file (all weights), or one file per weight. */
type Faces = string | Record<number, string>

const FONTS: Record<string, Faces> = {
  Inter: inter,
  Geist: geist,
  'Geist Mono': geistMono,
  Manrope: manrope,
  'DM Sans': dmSans,
  'Plus Jakarta Sans': jakarta,
  'Source Sans 3': sourceSans,
  'Nunito Sans': nunitoSans,
  'Work Sans': workSans,
  'Space Grotesk': spaceGrotesk,
  Sora: sora,
  Outfit: outfit,
  Fraunces: fraunces,
  'Playfair Display': playfair,
  'JetBrains Mono': jetbrains,
  'Fira Code': firaCode,
  'Source Code Pro': sourceCode,
  'IBM Plex Sans': { 400: plexSans400, 500: plexSans500, 600: plexSans600, 700: plexSans700 },
  'IBM Plex Serif': { 400: plexSerif400, 500: plexSerif500, 600: plexSerif600, 700: plexSerif700 },
  'IBM Plex Mono': { 400: plexMono400, 500: plexMono500, 600: plexMono600, 700: plexMono700 }
}

/** Fonts the preview can show exactly; anything else shows only if installed on this computer. */
export const BUNDLED_FONTS = new Set(Object.keys(FONTS))

const loading = new Map<string, Promise<void>>()

/** Register a bundled font under its own name (so `'Fraunces', serif` stacks pick it up). */
export function loadDesignFont(name: string): Promise<void> {
  const faces = FONTS[name]
  if (!faces) return Promise.resolve()
  let p = loading.get(name)
  if (!p) {
    const list = typeof faces === 'string' ? [new FontFace(name, `url(${faces})`, { weight: '100 900', display: 'swap' })] : Object.entries(faces).map(([w, url]) => new FontFace(name, `url(${url})`, { weight: w, display: 'swap' }))
    p = Promise.all(list.map((f) => f.load().then((loaded) => void document.fonts.add(loaded)))).then(() => undefined)
    p.catch(() => loading.delete(name))
    loading.set(name, p)
  }
  return p
}
