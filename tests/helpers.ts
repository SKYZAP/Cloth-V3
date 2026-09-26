import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { plainSecrets } from '../src/main/core/context'
import { createServices } from '../src/main/services'

export function makeServices() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cloth-test-'))
  const events: { channel: string; payload: unknown }[] = []
  const services = createServices({ dataDir, secrets: plainSecrets, emit: (channel, payload) => events.push({ channel, payload }), dbFile: ':memory:' })
  return { services, events, dataDir }
}
