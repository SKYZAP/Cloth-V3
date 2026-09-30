import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, sep } from 'node:path'
import { confine } from '../agent/workspace'

/** Where a custom tool runs: the workspace it may use, if any. */
export interface ToolEnv {
  workspace?: {
    root: string
    /** Writes allowed (flows, or chats that auto-approve edits). */
    writable: boolean
    /** Called with the absolute path of every file the tool writes. */
    onWrite?: (abs: string) => void
  }
}

/**
 * Libraries JavaScript tools can `require`. They ship with Cloth and with exported flow apps, so a
 * tool that uses them works in both. Loaded on first use.
 */
const LIBRARIES: Record<string, () => Promise<unknown>> = {
  pptxgenjs: async () => (await import('pptxgenjs')).default,
  docx: async () => import('docx')
}

export const TOOL_LIBRARIES = Object.keys(LIBRARIES)

/** Load the libraries a tool's code asks for, and return a synchronous `require` for the sandbox. */
export async function sandboxRequire(code: string): Promise<(name: string) => unknown> {
  const wanted = new Set([...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]))
  const loaded = new Map<string, unknown>()
  for (const name of wanted) if (LIBRARIES[name]) loaded.set(name, await LIBRARIES[name]())
  return (name: string) => {
    if (loaded.has(name)) return loaded.get(name)
    throw new Error(`require("${name}") is not available in tools. Available: ${TOOL_LIBRARIES.join(', ')}`)
  }
}

const isBytes = (v: unknown): v is ArrayBufferView => ArrayBuffer.isView(v)
const isArrayBuffer = (v: unknown): v is ArrayBuffer => Object.prototype.toString.call(v) === '[object ArrayBuffer]'

/** The `workspace` object JavaScript tools see: file access confined to the workspace folder. */
export function workspaceApi(env: ToolEnv): Record<string, unknown> {
  const ws = env.workspace
  const need = () => {
    if (!ws) throw new Error('No workspace here — give the flow (or chat) a workspace folder to read and write files')
    return ws
  }
  const rel = (abs: string) => relative(ws!.root, abs).split(sep).join('/')
  return {
    root: ws?.root ?? null,
    writable: !!ws?.writable,
    async write(path: string, data: unknown): Promise<string> {
      const w = need()
      if (!w.writable) throw new Error('This tool can only read the workspace here — file writes need edits to be approved in advance')
      const abs = await confine(w.root, String(path))
      const body = typeof data === 'string' ? data : isBytes(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : isArrayBuffer(data) ? Buffer.from(data) : JSON.stringify(data, null, 2)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, body)
      w.onWrite?.(abs)
      return rel(abs)
    },
    async read(path: string): Promise<string> {
      return readFile(await confine(need().root, String(path)), 'utf8')
    },
    async readBytes(path: string): Promise<Uint8Array> {
      return new Uint8Array(await readFile(await confine(need().root, String(path))))
    },
    async list(path = '.'): Promise<{ name: string; dir: boolean; size: number }[]> {
      const dir = await confine(need().root, String(path))
      const entries = await readdir(dir, { withFileTypes: true })
      return Promise.all(entries.map(async (e) => ({ name: e.name, dir: e.isDirectory(), size: e.isFile() ? (await stat(`${dir}${sep}${e.name}`)).size : 0 })))
    },
    async exists(path: string): Promise<boolean> {
      const abs = await confine(need().root, String(path))
      return stat(abs).then(
        () => true,
        () => false
      )
    }
  }
}
