import type { EngineBackend, EngineFlavour, EngineRelease } from '@shared/types'

/** The two llama.cpp sources and how their Windows downloads are named. */
export const ENGINE_REPOS: Record<EngineFlavour, string> = {
  official: 'ggml-org/llama.cpp',
  prism: 'PrismML-Eng/llama.cpp'
}

export const ENGINE_BACKENDS: EngineBackend[] = ['vulkan', 'rocm', 'cuda', 'cpu']

/** A release's file name for each backend (x64 Windows): `…-bin-win-<backend>-x64.zip`. */
const ASSET: Record<EngineBackend, RegExp> = {
  vulkan: /^llama-.*-bin-win-vulkan-x64\.zip$/,
  rocm: /^llama-.*-bin-win-(?:hip-radeon|rocm-[\d.]+)-x64\.zip$/,
  // 12.4 runs on the widest range of NVIDIA drivers.
  cuda: /^llama-.*-bin-win-cuda-12\.4-x64\.zip$/,
  cpu: /^llama-.*-bin-win-cpu-x64\.zip$/
}
/** CUDA builds also need NVIDIA's runtime DLLs, shipped as a separate zip. */
const CUDART = /^cudart-llama-bin-win-cuda-12\.4-x64\.zip$/

export interface ReleaseJson {
  tag_name?: string
  html_url?: string
  published_at?: string
  prerelease?: boolean
  draft?: boolean
  assets?: { name: string; size: number; browser_download_url: string }[]
}

export interface EngineAssets {
  release: EngineRelease
  files: Partial<Record<EngineBackend, { url: string; size: number; name: string; extra?: { url: string; size: number; name: string } }>>
}

/** What a release offers this PC: one zip per backend (plus the CUDA runtime), or null when it has no Windows builds. */
export function releaseAssets(flavour: EngineFlavour, r: ReleaseJson): EngineAssets | null {
  if (!r.tag_name || r.draft) return null
  const files: EngineAssets['files'] = {}
  const cudart = r.assets?.find((a) => CUDART.test(a.name))
  for (const b of ENGINE_BACKENDS) {
    const a = r.assets?.find((x) => ASSET[b].test(x.name))
    if (!a) continue
    files[b] = { url: a.browser_download_url, size: a.size, name: a.name, ...(b === 'cuda' && cudart ? { extra: { url: cudart.browser_download_url, size: cudart.size, name: cudart.name } } : {}) }
  }
  if (!Object.keys(files).length) return null
  const sizes = Object.fromEntries(Object.entries(files).map(([b, f]) => [b, f!.size + (f!.extra?.size ?? 0)])) as EngineRelease['sizes']
  return {
    release: { flavour, tag: r.tag_name, publishedAt: r.published_at ?? '', url: r.html_url ?? `https://github.com/${ENGINE_REPOS[flavour]}/releases/tag/${r.tag_name}`, sizes },
    files
  }
}

/** The newest release with Windows builds (official builds are tagged pre-release; "latest" skips them). */
export function newestRelease(flavour: EngineFlavour, releases: ReleaseJson[]): EngineAssets | null {
  for (const r of releases) {
    const a = releaseAssets(flavour, r)
    if (a) return a
  }
  return null
}

/** A tag's build number (b11755 → 11755, prism-b10787-73bfe6c → 10787), to tell which is newer. */
export function buildNumber(tag: string): number {
  const m = /b(\d+)/.exec(tag)
  return m ? Number(m[1]) : 0
}

export const isNewer = (latest: string, installed: string) => buildNumber(latest) > buildNumber(installed)
