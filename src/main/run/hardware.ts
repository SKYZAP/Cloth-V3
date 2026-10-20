import { totalmem } from 'node:os'
import type { EngineBackend, Hardware, RunDevice } from '@shared/types'

type Vendor = Hardware['gpus'][number]['vendor']

export function vendorOf(name: string): Vendor {
  if (/radeon|amd|\bati\b/i.test(name)) return 'amd'
  if (/nvidia|geforce|rtx|gtx|quadro|tesla/i.test(name)) return 'nvidia'
  if (/intel|arc\b|iris|uhd/i.test(name)) return 'intel'
  if (/apple|\bm\d\b/i.test(name)) return 'apple'
  return 'other'
}

/** The build that suits a GPU: CUDA for NVIDIA, Vulkan for everything else with a GPU, CPU without one. */
export function recommendedBackend(gpus: Hardware['gpus']): EngineBackend {
  const main = gpus[0]
  if (!main) return 'cpu'
  return main.vendor === 'nvidia' ? 'cuda' : 'vulkan'
}

/** GPUs from llama.cpp's own device list (`--list-devices`): the most reliable sizes and free memory. */
export function fromDevices(devices: RunDevice[]): Hardware['gpus'] {
  // One physical card can appear once per backend; keep the largest entry per name.
  const byName = new Map<string, Hardware['gpus'][number]>()
  for (const d of devices) {
    const name = d.description.replace(/\s*\(.*\)\s*$/, '').trim()
    const cur = byName.get(name)
    if (!cur || d.totalMiB > cur.totalMiB) byName.set(name, { name, totalMiB: d.totalMiB, freeMiB: d.freeMiB, vendor: vendorOf(name) })
  }
  return [...byName.values()].sort((a, b) => b.totalMiB - a.totalMiB)
}

/**
 * GPUs from Windows when no llama.cpp is installed yet: names from the display adapters and memory from
 * the driver's registry value (Win32_VideoController's AdapterRAM stops at 4 GB).
 */
export const WINDOWS_GPU_SCRIPT = `
$out = @()
Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
  if ($p.DriverDesc -and $p.'HardwareInformation.qwMemorySize') { $out += [pscustomobject]@{ name = $p.DriverDesc; bytes = [int64]$p.'HardwareInformation.qwMemorySize' } }
}
$out | ConvertTo-Json -Compress
`

export function parseWindowsGpus(stdout: string): Hardware['gpus'] {
  let items: unknown
  try {
    items = JSON.parse(stdout.trim() || '[]')
  } catch {
    return []
  }
  const list = (Array.isArray(items) ? items : [items]) as { name?: string; bytes?: number }[]
  const byName = new Map<string, Hardware['gpus'][number]>()
  for (const i of list) {
    if (!i?.name || !i.bytes) continue
    const totalMiB = Math.round(i.bytes / 1024 / 1024)
    // Integrated GPUs report a small reserved slice; leave out anything under 1 GB.
    if (totalMiB < 1024) continue
    const cur = byName.get(i.name)
    if (!cur || totalMiB > cur.totalMiB) byName.set(i.name, { name: i.name, totalMiB, freeMiB: null, vendor: vendorOf(i.name) })
  }
  return [...byName.values()].sort((a, b) => b.totalMiB - a.totalMiB)
}

export function hardwareFrom(gpus: Hardware['gpus'], source: Hardware['source'], ramMiB = Math.round(totalmem() / 1024 / 1024)): Hardware {
  return { gpus, ramMiB, recommendedBackend: recommendedBackend(gpus), source: gpus.length ? source : 'none' }
}
