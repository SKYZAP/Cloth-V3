import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { plainSecrets } from '../src/main/core/context'
import { createServices } from '../src/main/services'

export const REPO = resolve(__dirname, '..')

export function makeServices() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cloth-test-'))
  const events: { channel: string; payload: unknown }[] = []
  const services = createServices({
    dataDir,
    secrets: plainSecrets,
    emit: (channel, payload) => events.push({ channel, payload }),
    dbFile: ':memory:',
    sidecarsDir: join(REPO, 'sidecars'),
    examplesDir: join(REPO, 'resources', 'examples')
  })
  // Tests script every model reply; the background title request would take one of them.
  services.settings.update({ aiTitles: false })
  return { services, events, dataDir }
}
