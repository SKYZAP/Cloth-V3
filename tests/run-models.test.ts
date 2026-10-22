import { describe, expect, it } from 'vitest'
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modelMeta, readGgufMeta, reasoningKind } from '../src/main/run/gguf'
import { fitOf, groupFiles, paramsOf, prettyName, quantOf } from '../src/main/run/hub'
import { backendsFor, buildNumber, isNewer, newestRelease, releaseAssets } from '../src/main/run/engines'
import { untarGz } from '../src/main/run/untar'
import { fromDevices, parseMacSysctl, parseWindowsGpus, recommendedBackend } from '../src/main/run/hardware'
import { buildCommand, reasoningArgs } from '../src/main/run/run'
import type { Runner } from '../src/shared/types'

const GB = 1024 ** 3

/** A minimal GGUF file: header and key/values, no tensors. */
function gguf(kv: [string, number, unknown][]): Buffer {
  const parts: Buffer[] = []
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)])
  parts.push(Buffer.from('GGUF'), u32(3), u64(0), u64(kv.length))
  for (const [k, type, v] of kv) {
    parts.push(str(k), u32(type))
    if (type === 4) parts.push(u32(v as number))
    else if (type === 8) parts.push(str(v as string))
    else if (type === 9) {
      const arr = v as string[]
      parts.push(u32(8), u64(arr.length), ...arr.map(str))
    }
  }
  return Buffer.concat(parts)
}

describe('GGUF header', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloth-gguf-'))
  const file = join(dir, 'm.gguf')
  writeFileSync(file, gguf([
    ['general.architecture', 8, 'qwen3'],
    ['general.name', 8, 'Qwen3 8B'],
    ['qwen3.context_length', 4, 40960],
    ['qwen3.block_count', 4, 36],
    ['qwen3.attention.head_count', 4, 32],
    ['qwen3.attention.head_count_kv', 4, 8],
    ['qwen3.attention.key_length', 4, 128],
    ['qwen3.attention.value_length', 4, 128],
    // A vocabulary bigger than kept arrays: skipped, and reading carries on past it.
    ['tokenizer.ggml.tokens', 9, Array.from({ length: 3000 }, (_, i) => `tok${i}`)],
    ['tokenizer.chat_template', 8, "{%- if enable_thinking is defined and enable_thinking is false %}<think>\n\n</think>{% endif %}"]
  ]))

  it('reads the keys and skips the vocabulary', () => {
    const m = readGgufMeta(file)
    expect(m['general.architecture']).toBe('qwen3')
    expect(m['tokenizer.ggml.tokens']).toBeNull()
    expect(String(m['tokenizer.chat_template'])).toContain('enable_thinking')
  })

  it('works out the trained context, the cache per token and the reasoning kind', () => {
    const meta = modelMeta(file)
    expect(meta).toMatchObject({ architecture: 'qwen3', name: 'Qwen3 8B', trainedContext: 40960, reasoning: 'toggle' })
    // 36 layers × 8 KV heads × (128 + 128) × 2 bytes.
    expect(meta.kvBytesPerToken).toBe(36 * 8 * 256 * 2)
  })

  it('counts only the attention layers of a hybrid model', () => {
    const hybrid = join(dir, 'h.gguf')
    writeFileSync(hybrid, gguf([
      ['general.architecture', 8, 'qwen35'],
      ['qwen35.block_count', 4, 64],
      ['qwen35.full_attention_interval', 4, 4],
      ['qwen35.attention.head_count', 4, 24],
      ['qwen35.attention.head_count_kv', 4, 4],
      ['qwen35.attention.key_length', 4, 256],
      ['qwen35.attention.value_length', 4, 256]
    ]))
    expect(modelMeta(hybrid).kvBytesPerToken).toBe(16 * 4 * 512 * 2)
  })

  it('tells reasoning kinds apart', () => {
    expect(reasoningKind('{{ reasoning_effort }}')).toBe('levels')
    expect(reasoningKind('<think>')).toBe('toggle')
    expect(reasoningKind('{{ messages }}')).toBeNull()
    expect(reasoningKind(undefined)).toBeNull()
  })
})

describe('Hugging Face files', () => {
  const hw = { gpus: [{ name: 'Radeon RX 7800 XT', totalMiB: 16368, freeMiB: 15000, vendor: 'amd' as const }], ramMiB: 65536 }

  it('names quantizations, including shards and folders', () => {
    expect(quantOf('Qwen3-8B-Q4_K_M.gguf')).toBe('Q4_K_M')
    expect(quantOf('Qwen3-8B-UD-Q4_K_XL.gguf')).toBe('UD-Q4_K_XL')
    expect(quantOf('Qwen3-8B-BF16.gguf')).toBe('BF16')
    expect(quantOf('Qwen3-8B-IQ4_XS.gguf')).toBe('IQ4_XS')
    expect(quantOf('big-Q4_K_M-00001-of-00003.gguf')).toBe('Q4_K_M')
    expect(quantOf('Q6_K/model-00001-of-00002.gguf')).toBe('Q6_K')
    expect(prettyName('Qwen3-8B-GGUF')).toBe('Qwen3 8B')
    // A repo whose GGUF total is only its MTP head: the name's size wins.
    expect(paramsOf('cdiamond/Qwen3.8-27B-NVFP4-MTP-GGUF', 461e6)).toBe(27e9)
    expect(paramsOf('unsloth/Qwen3-30B-A3B-GGUF', 30.5e9)).toBe(30.5e9)
    expect(paramsOf('mudler/locate-anything.cpp', 3.8e9)).toBe(3.8e9)
  })

  it('checks each size against the GPU and system memory', () => {
    expect(fitOf(8 * GB, hw)).toBe('gpu')
    expect(fitOf(30 * GB, hw)).toBe('ram')
    expect(fitOf(200 * GB, hw)).toBe('too-big')
    expect(fitOf(4 * GB, { gpus: [], ramMiB: 16384 })).toBe('ram')
  })

  it('groups shards and recommends the best size that leaves room for context', () => {
    const files = groupFiles('unsloth/Qwen3-8B-GGUF', [
      { path: 'Qwen3-8B-Q4_K_M.gguf', size: 5.0 * GB },
      { path: 'Qwen3-8B-Q6_K.gguf', size: 6.7 * GB },
      { path: 'Qwen3-8B-Q8_0.gguf', size: 8.7 * GB },
      { path: 'Qwen3-8B-BF16.gguf', size: 16.4 * GB },
      { path: 'mmproj-F16.gguf', size: 0.9 * GB },
      { path: 'README.md', size: 1 }
    ], hw, 8.2e9)
    expect(files.projectors.map((p) => p.path)).toEqual(['mmproj-F16.gguf'])
    expect(files.groups.map((g) => g.quant)).toEqual(['Q4_K_M', 'Q6_K', 'Q8_0', 'BF16'])
    expect(files.groups.find((g) => g.quant === 'BF16')?.fit).toBe('ram')
    // Q8_0 needs ~9.8 GB, within three quarters of 16 GB: the best quality with room to spare.
    expect(files.groups.filter((g) => g.recommended).map((g) => g.quant)).toEqual(['Q8_0'])
    const split = groupFiles('x/y', [{ path: 'm-Q4_K_M-00002-of-00002.gguf', size: GB }, { path: 'm-Q4_K_M-00001-of-00002.gguf', size: GB }], hw, null)
    expect(split.groups[0].files.map((f) => f.path)).toEqual(['m-Q4_K_M-00001-of-00002.gguf', 'm-Q4_K_M-00002-of-00002.gguf'])
    expect(split.groups[0].size).toBe(2 * GB)
  })
})

describe('llama.cpp releases', () => {
  const asset = (name: string, size = 10) => ({ name, size, browser_download_url: `https://x/${name}` })
  const official = {
    tag_name: 'b11755',
    prerelease: true,
    assets: [asset('llama-b11755-bin-win-vulkan-x64.zip'), asset('llama-b11755-bin-win-rocm-10.0-x64.zip'), asset('llama-b11755-bin-win-cuda-12.4-x64.zip', 20), asset('cudart-llama-bin-win-cuda-12.4-x64.zip', 30), asset('llama-b11755-bin-win-cpu-x64.zip'), asset('llama-b11755-bin-win-vulkan-arm64.zip')]
  }
  const prism = { tag_name: 'prism-b10787-73bfe6c', assets: [asset('llama-prism-b10787-73bfe6c-bin-win-hip-radeon-x64.zip'), asset('llama-prism-b10787-73bfe6c-bin-win-vulkan-x64.zip')] }

  it('matches each build to its hardware, with the CUDA runtime alongside', () => {
    const a = releaseAssets('official', official)!
    expect(Object.keys(a.files).sort()).toEqual(['cpu', 'cuda', 'rocm', 'vulkan'])
    expect(a.files.cuda?.extra?.name).toBe('cudart-llama-bin-win-cuda-12.4-x64.zip')
    expect(a.release.sizes.cuda).toBe(50)
    expect(Object.keys(releaseAssets('prism', prism)!.files).sort()).toEqual(['rocm', 'vulkan'])
  })

  it('takes the newest release that has Windows builds and compares build numbers', () => {
    expect(newestRelease('official', [{ tag_name: 'v0.7.0', assets: [] }, official])?.release.tag).toBe('b11755')
    expect(buildNumber('prism-b10787-73bfe6c')).toBe(10787)
    expect(isNewer('b11755', 'b11700')).toBe(true)
    expect(isNewer('prism-b10777-e3de715', 'prism-b10787-73bfe6c')).toBe(false)
  })
})

describe('hardware', () => {
  it('reads GPUs from llama.cpp and from Windows, largest first', () => {
    expect(fromDevices([{ id: 'Vulkan0', description: 'AMD Radeon RX 7800 XT', totalMiB: 16368, freeMiB: 15000 }, { id: 'ROCm0', description: 'AMD Radeon RX 7800 XT', totalMiB: 16384, freeMiB: 15100 }])).toEqual([
      { name: 'AMD Radeon RX 7800 XT', totalMiB: 16384, freeMiB: 15100, vendor: 'amd' }
    ])
    const win = parseWindowsGpus(JSON.stringify([{ name: 'Intel(R) UHD Graphics', bytes: 128 * 1024 * 1024 }, { name: 'NVIDIA GeForce RTX 4070', bytes: 12 * GB }]))
    expect(win).toEqual([{ name: 'NVIDIA GeForce RTX 4070', totalMiB: 12288, freeMiB: null, vendor: 'nvidia' }])
    expect(recommendedBackend(win)).toBe('cuda')
    expect(recommendedBackend([])).toBe('cpu')
    expect(parseWindowsGpus('not json')).toEqual([])
  })
})

describe('reasoning flags', () => {
  it('passes an effort level or turns thinking off, only where the model allows it', () => {
    expect(reasoningArgs('high', 'levels')).toEqual(['--chat-template-kwargs', '{"reasoning_effort":"high"}'])
    expect(reasoningArgs('off', 'toggle')).toEqual(['--reasoning-budget', '0'])
    expect(reasoningArgs('on', 'toggle')).toEqual([])
    expect(reasoningArgs('off', 'levels')).toEqual([])
    expect(reasoningArgs('high', null)).toEqual([])
    expect(reasoningArgs('default', 'levels')).toEqual([])
    const r = { modelPath: 'm.gguf', mmprojPath: null, device: null, gpuLayers: 99, flashAttention: true, contextSize: 8192, port: 8091, alias: 'm', sampling: {}, extraArgs: '--jinja', reasoning: 'medium' } as unknown as Runner
    const args = buildCommand(r, 'C:/llama/llama-server.exe', 'levels').args
    expect(args.slice(args.indexOf('--chat-template-kwargs'), args.indexOf('--chat-template-kwargs') + 2)).toEqual(['--chat-template-kwargs', '{"reasoning_effort":"medium"}'])
    // Extra flags still come last, so they can override.
    expect(args.at(-1)).toBe('--jinja')
  })
})

describe('macOS', () => {
  const asset = (name: string, size = 10) => ({ name, size, browser_download_url: `https://x/${name}` })
  const mac = { platform: 'darwin' as const, arch: 'arm64' }

  it('picks the Apple silicon build of either llama.cpp', () => {
    const official = { tag_name: 'b11815', assets: [asset('llama-b11815-bin-win-vulkan-x64.zip'), asset('llama-b11815-bin-macos-arm64.tar.gz', 30), asset('llama-b11815-bin-macos-x64.tar.gz')] }
    const prism = { tag_name: 'prism-b10787-73bfe6c', assets: [asset('llama-prism-b10787-73bfe6c-bin-macos-arm64-kleidiai.tar.gz'), asset('llama-prism-b10787-73bfe6c-bin-macos-arm64.tar.gz', 40)] }
    const a = releaseAssets('official', official, mac)!
    expect(Object.keys(a.files)).toEqual(['metal'])
    expect(a.files.metal?.name).toBe('llama-b11815-bin-macos-arm64.tar.gz')
    expect(releaseAssets('prism', prism, mac)!.files.metal?.name).toBe('llama-prism-b10787-73bfe6c-bin-macos-arm64.tar.gz')
    expect(releaseAssets('official', official, { platform: 'darwin', arch: 'x64' })!.files.metal?.name).toBe('llama-b11815-bin-macos-x64.tar.gz')
    // A release with only Windows builds is skipped for the newest Mac one.
    expect(newestRelease('official', [{ tag_name: 'b11816', assets: [asset('llama-b11816-bin-win-cpu-x64.zip')] }, official], mac)?.release.tag).toBe('b11815')
    expect(backendsFor(mac)).toEqual(['metal'])
    expect(backendsFor({ platform: 'linux', arch: 'x64' })).toEqual([])
  })

  it('reads the chip and its share of memory, and fits models to it', () => {
    const gpus = parseMacSysctl(`${36 * GB}\nApple M3 Pro\n`)
    expect(gpus).toEqual([{ name: 'Apple M3 Pro GPU', totalMiB: Math.round(36 * 1024 * 0.7), freeMiB: null, vendor: 'apple' }])
    expect(parseMacSysctl(`${16 * GB}\nIntel(R) Core(TM) i7\n`)).toEqual([])
    expect(recommendedBackend(gpus, 'darwin')).toBe('metal')
    // Unified memory: no slower pool to spill into.
    expect(fitOf(20 * GB, { gpus, ramMiB: 36 * 1024 })).toBe('gpu')
    expect(fitOf(30 * GB, { gpus, ramMiB: 36 * 1024 })).toBe('too-big')
  })

  it('unpacks a .tar.gz with executables and library links', async () => {
    const block = (name: string, body: Buffer, type: string, opts: { mode?: number; link?: string } = {}) => {
      const h = Buffer.alloc(512)
      h.write(name, 0)
      h.write(`${(opts.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100)
      h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
      h.write(type, 156)
      if (opts.link) h.write(opts.link, 157)
      h.write('ustar\0', 257)
      const pad = Buffer.alloc((512 - (body.length % 512)) % 512)
      return Buffer.concat([h, body, pad])
    }
    const good = [
      block('build/', Buffer.alloc(0), '5', { mode: 0o755 }),
      block('build/bin/llama-server', Buffer.from('#!/bin/sh\necho hi\n'), '0', { mode: 0o755 }),
      block('build/bin/libllama.0.dylib', Buffer.from('lib'), '0'),
      block('build/bin/libllama.dylib', Buffer.alloc(0), '2', { link: 'libllama.0.dylib' })
    ]
    const dir = mkdtempSync(join(tmpdir(), 'cloth-untar-'))
    const file = join(dir, 'llama.tar.gz')
    writeFileSync(file, gzipSync(Buffer.concat([...good, block('../escape.txt', Buffer.from('x'), '0'), Buffer.alloc(1024)])))
    await expect(untarGz(file, join(dir, 'bad'))).rejects.toThrow('outside')

    writeFileSync(file, gzipSync(Buffer.concat([...good, Buffer.alloc(1024)])))
    const written = await untarGz(file, join(dir, 'ok'))
    expect(written).toEqual(['build/bin/llama-server', 'build/bin/libllama.0.dylib', 'build/bin/libllama.dylib'])
    const exe = join(dir, 'ok', 'build', 'bin', 'llama-server')
    expect(readFileSync(exe, 'utf8')).toContain('echo hi')
    if (process.platform !== 'win32') {
      expect(statSync(exe).mode & 0o111).not.toBe(0)
      const link = join(dir, 'ok', 'build', 'bin', 'libllama.dylib')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe('libllama.0.dylib')
    }
  })
})
