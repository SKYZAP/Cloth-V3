import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { generateImages } from '@earendil-works/pi-ai/compat'
import type { ImagesModel } from '@earendil-works/pi-ai'
import type { GeneratedImage, ImageSize, ModelRef } from '@shared/types'
import { newId, type Ctx } from './core/context'
import type { ProviderService } from './providers/providers'
import type { SettingsService } from './core/settings'

/**
 * Image generation. OpenAI and OpenAI-compatible servers use the Images API
 * (`POST /images/generations`); OpenRouter goes through pi-ai's image API (chat completions
 * with image output). Files are stored under <data>/images and served to the UI as
 * cloth-image://<id>, so chats keep a reference instead of megabytes of base64.
 */
export const IMAGE_ID = /^img_[\w-]+$/

interface ImageMeta extends GeneratedImage {
  id: string
  file: string
  mime: string
  createdAt: number
}

export class ImageService {
  readonly dir: string

  constructor(
    private ctx: Ctx,
    private providers: ProviderService,
    private settings: SettingsService
  ) {
    this.dir = join(ctx.dataDir, 'images')
  }

  /** The model generate_image uses: the Settings default, else the first model marked as an image model. */
  defaultModel(): ModelRef | null {
    const chosen = this.settings.get().imageModel
    if (chosen) return chosen
    for (const p of this.providers.list()) {
      if (!p.enabled) continue
      const m = p.models.find((x) => x.image)
      if (m) return { providerId: p.id, modelId: m.id }
    }
    return null
  }

  async generate(input: { prompt: string; size?: ImageSize; model?: ModelRef | null; signal?: AbortSignal }): Promise<ImageMeta> {
    const ref = input.model ?? this.defaultModel()
    if (!ref) throw new Error('No image model configured — mark one as “Image” on the Models page, or pick a default in Settings')
    const prompt = input.prompt.trim()
    if (!prompt) throw new Error('The prompt is empty')
    const provider = this.providers.get(ref.providerId)
    if (provider.kind === 'anthropic') throw new Error('Anthropic does not offer image generation')
    const size = input.size ?? 'auto'
    const started = Date.now()
    let bytes: Buffer
    let mime = 'image/png'
    let revisedPrompt: string | undefined
    try {
      if (/openrouter\.ai/i.test(provider.baseUrl)) ({ bytes, mime, revisedPrompt } = await this.viaOpenRouter(ref, prompt, input.signal))
      else ({ bytes, mime, revisedPrompt } = await this.viaImagesApi(ref, prompt, size, input.signal))
      this.providers.usage.tool('generate_image', ref.modelId, Date.now() - started, true)
    } catch (err) {
      this.providers.usage.tool('generate_image', ref.modelId, Date.now() - started, false)
      throw err
    }
    const { width, height } = imageSize(bytes)
    const id = newId('img_')
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
    await mkdir(this.dir, { recursive: true })
    const file = join(this.dir, `${id}.${ext}`)
    await writeFile(file, bytes)
    const meta: ImageMeta = { id, file, mime, status: 'complete', prompt, revisedPrompt, size, width, height, model: ref.modelId, createdAt: Date.now() }
    await writeFile(join(this.dir, `${id}.json`), JSON.stringify(meta, null, 2))
    this.ctx.log('images', `generated ${id} with ${ref.modelId} in ${Date.now() - started}ms`)
    return meta
  }

  /** Path + type of a stored image, for the cloth-image:// protocol. */
  async file(id: string): Promise<{ file: string; mime: string } | null> {
    if (!IMAGE_ID.test(id)) return null
    try {
      const meta = JSON.parse(await readFile(join(this.dir, `${id}.json`), 'utf8')) as ImageMeta
      return existsSync(meta.file) ? { file: meta.file, mime: meta.mime } : null
    } catch {
      // Meta missing: fall back to whichever extension exists.
      for (const f of await readdir(this.dir).catch(() => [] as string[])) if (f.startsWith(`${id}.`) && !f.endsWith('.json')) return { file: join(this.dir, f), mime: 'image/png' }
      return null
    }
  }

  private async viaImagesApi(ref: ModelRef, prompt: string, size: ImageSize, signal?: AbortSignal): Promise<{ bytes: Buffer; mime: string; revisedPrompt?: string }> {
    const provider = this.providers.get(ref.providerId)
    const key = this.providers.apiKey(provider.id)
    const dalle = /^dall-e/i.test(ref.modelId)
    const body: Record<string, unknown> = { model: ref.modelId, prompt, n: 1 }
    // gpt-image models always return base64 and reject response_format; DALL·E defaults to URLs.
    if (dalle) body.response_format = 'b64_json'
    if (size !== 'auto') body.size = dalle && size !== '1024x1024' ? (size === '1536x1024' ? '1792x1024' : '1024x1792') : size
    const res = await fetch(`${provider.baseUrl}/images/generations`, {
      method: 'POST',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(300_000)]),
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...provider.headers },
      body: JSON.stringify(body)
    })
    const text = await res.text()
    if (!res.ok) {
      let message = text.slice(0, 400)
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message
      } catch {
        /* not JSON */
      }
      throw new Error(res.status === 404 ? `${provider.name} has no /images/generations endpoint (HTTP 404)` : `Image generation failed (HTTP ${res.status}): ${message}`)
    }
    const data = (JSON.parse(text) as { data?: { b64_json?: string; url?: string; revised_prompt?: string }[] }).data?.[0]
    if (!data) throw new Error('The server returned no image')
    if (data.b64_json) return { bytes: Buffer.from(data.b64_json, 'base64'), mime: sniffMime(Buffer.from(data.b64_json.slice(0, 32), 'base64')), revisedPrompt: data.revised_prompt }
    if (data.url) {
      const img = await fetch(data.url, { signal })
      if (!img.ok) throw new Error(`Couldn't download the generated image (HTTP ${img.status})`)
      const bytes = Buffer.from(await img.arrayBuffer())
      return { bytes, mime: sniffMime(bytes), revisedPrompt: data.revised_prompt }
    }
    throw new Error('The server returned neither image data nor a URL')
  }

  private async viaOpenRouter(ref: ModelRef, prompt: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mime: string; revisedPrompt?: string }> {
    const provider = this.providers.get(ref.providerId)
    const model: ImagesModel<'openrouter-images'> = {
      id: ref.modelId,
      name: ref.modelId,
      api: 'openrouter-images',
      provider: provider.id,
      baseUrl: provider.baseUrl,
      input: ['text'],
      output: ['image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      headers: Object.keys(provider.headers).length ? provider.headers : undefined
    }
    const res = await generateImages(model, { input: [{ type: 'text', text: prompt }] }, { apiKey: this.providers.apiKey(provider.id), signal })
    if (res.stopReason !== 'stop') throw new Error(res.errorMessage || `Image generation ${res.stopReason}`)
    const image = res.output.find((o) => o.type === 'image')
    if (!image || image.type !== 'image') throw new Error('The model returned no image')
    const text = res.output.filter((o) => o.type === 'text').map((o) => (o.type === 'text' ? o.text : '')).join(' ').trim()
    return { bytes: Buffer.from(image.data, 'base64'), mime: image.mimeType || 'image/png', revisedPrompt: text || undefined }
  }
}

function sniffMime(b: Buffer): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return 'image/png'
}

/** Width/height from PNG, JPEG or WebP headers (no image library needed). */
export function imageSize(b: Buffer): { width?: number; height?: number } {
  try {
    if (b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2
      while (i < b.length) {
        if (b[i] !== 0xff) return {}
        const marker = b[i + 1]
        const len = b.readUInt16BE(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
        i += 2 + len
      }
    }
    if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(12, 16).toString('ascii') === 'VP8X') {
      return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
    }
  } catch {
    /* truncated header */
  }
  return {}
}
