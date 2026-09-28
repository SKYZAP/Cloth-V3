import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ToolTrace } from '../src/shared/types'
import { imageSize } from '../src/main/images'
import { isImageModelId } from '../src/main/providers/providers'
import { makeServices } from './helpers'

// A real 3×2 PNG (red pixels).
const PNG_3x2 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEklEQVR4nGP4z8DAwMDAwMAAABAAAf/NSW5aAAAAAElFTkSuQmCC'

const requests: Record<string, unknown>[] = []
let failNext = false
let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ data: [{ id: 'gpt-image-1' }, { id: 'dall-e-3' }, { id: 'local-chat' }] }))
    }
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const parsed = JSON.parse(body)
        requests.push(parsed)
        res.setHeader('content-type', 'application/json')
        if (failNext) {
          failNext = false
          res.statusCode = 400
          return res.end(JSON.stringify({ error: { message: 'Your request was rejected by the safety system.' } }))
        }
        setTimeout(() => res.end(JSON.stringify({ data: [{ b64_json: PNG_3x2, revised_prompt: `refined: ${parsed.prompt}` }] })), 50)
      })
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
afterAll(() => server.close())

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('image generation', () => {
  it('detects image models by id and reads PNG dimensions', () => {
    for (const id of ['gpt-image-1', 'dall-e-3', 'black-forest-labs/flux.2-pro', 'google/gemini-2.5-flash-image', 'stabilityai/sdxl-turbo']) expect(isImageModelId(id)).toBe(true)
    for (const id of ['gpt-4o', 'qwen/qwen3.5-9b', 'llava-v1.6', 'text-embedding-3-small']) expect(isImageModelId(id)).toBe(false)
    expect(imageSize(Buffer.from(PNG_3x2, 'base64'))).toEqual({ width: 3, height: 2 })
  })

  it('generates through the Images API, stores the file and records the revised prompt', async () => {
    const { services } = makeServices()
    const p = services.providers.create({ name: 'Images', kind: 'openai-compatible', baseUrl: base })
    const refreshed = await services.providers.refreshModels(p.id)
    expect(refreshed.models.filter((m) => m.image).map((m) => m.id)).toEqual(['gpt-image-1', 'dall-e-3'])
    expect(services.images.defaultModel()).toEqual({ providerId: p.id, modelId: 'gpt-image-1' })

    const img = await services.images.generate({ prompt: 'a red square', size: '1024x1024' })
    expect(img).toMatchObject({ status: 'complete', width: 3, height: 2, revisedPrompt: 'refined: a red square', model: 'gpt-image-1' })
    expect(existsSync(img.file)).toBe(true)
    expect(requests.at(-1)).toEqual({ model: 'gpt-image-1', prompt: 'a red square', n: 1, size: '1024x1024' })
    expect(await services.images.file(img.id)).toMatchObject({ mime: 'image/png' })
    expect(await services.images.file('../../etc/passwd')).toBeNull()

    // DALL·E needs base64 requested explicitly and uses its own landscape size.
    await services.images.generate({ prompt: 'wide', size: '1536x1024', model: { providerId: p.id, modelId: 'dall-e-3' } })
    expect(requests.at(-1)).toMatchObject({ model: 'dall-e-3', response_format: 'b64_json', size: '1792x1024' })
  })

  it('chat: generate_image shows progress then the image; errors become an error card', async () => {
    const { services } = makeServices()
    const images = services.providers.create({ name: 'Images', kind: 'openai-compatible', baseUrl: base })
    await services.providers.refreshModels(images.id)
    services.settings.update({ imageModel: { providerId: images.id, modelId: 'gpt-image-1' } })
    const chatProvider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const session = services.chat.create({ model: { providerId: chatProvider.id, modelId: 'faux-1' }, knowledgeEnabled: false, skillsEnabled: false, customTools: false })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let sawImagesSection = false
    faux.setResponses([
      (ctx: TranscriptContext) => {
        sawImagesSection = JSON.stringify(ctx.messages).includes('## Images')
        return fauxAssistantMessage([fauxToolCall('generate_image', { prompt: 'a lighthouse at dusk', size: '1536x1024' }, { id: 'g1' })], { stopReason: 'toolUse' })
      },
      fauxAssistantMessage('Here it is.'),
      fauxAssistantMessage([fauxToolCall('generate_image', { prompt: 'something disallowed' }, { id: 'g2' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('That one was rejected.')
    ])
    const traces = async (text: string) => {
      await services.chat.send(session.id, text)
      for (let i = 0; i < 400 && services.chat.isRunning(session.id); i++) await wait(10)
      return services.chat
        .messages(session.id)
        .flatMap((m) => m.blocks)
        .filter((b) => b.type === 'tool')
        .map((b) => (b as { trace: ToolTrace }).trace)
    }
    const first = (await traces('draw a lighthouse')).find((t) => t.id === 'g1')!
    expect(sawImagesSection).toBe(true)
    expect(first.image).toMatchObject({ status: 'complete', prompt: 'a lighthouse at dusk', size: '1536x1024', width: 3, height: 2, model: 'gpt-image-1' })
    expect(first.image?.id).toMatch(/^img_/)
    expect(first.result).toMatch(/Generated a 3×2 image with gpt-image-1/)

    failNext = true
    const second = (await traces('now something else')).find((t) => t.id === 'g2')!
    expect(second.status).toBe('error')
    expect(second.image).toMatchObject({ status: 'error', prompt: 'something disallowed' })
    expect(second.image?.error).toMatch(/safety system/)
  })

  it('no generate_image tool when images are off or no image model exists', async () => {
    const { services } = makeServices()
    const chatProvider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const session = services.chat.create({ model: { providerId: chatProvider.id, modelId: 'faux-1' }, knowledgeEnabled: false, skillsEnabled: false, customTools: false })
    expect(services.runtime.toolDefinitions({ collectionIds: [], skillsEnabled: false, workspace: null, sessionId: session.id, images: true })).not.toContain('generate_image')
    const images = services.providers.create({ name: 'Images', kind: 'openai-compatible', baseUrl: base })
    await services.providers.refreshModels(images.id)
    expect(services.runtime.toolDefinitions({ collectionIds: [], skillsEnabled: false, workspace: null, sessionId: session.id, images: true })).toContain('generate_image')
    expect(services.runtime.toolDefinitions({ collectionIds: [], skillsEnabled: false, workspace: null, sessionId: session.id, images: false })).not.toContain('generate_image')
  })
})
