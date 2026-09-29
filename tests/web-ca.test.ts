import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import { fetchWithWebCa } from '../src/main/web/transport'

const directories: string[] = []

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('web CA trust', () => {
  it('webFetch_whenPrivateCaSelected_shouldTrustItWithoutDisablingVerification', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cloth-web-ca-'))
    directories.push(directory)
    const keyPath = join(directory, 'server.key')
    const certPath = join(directory, 'ca.pem')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'])
    const server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('trusted')
    })
    await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve()))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('HTTPS test server did not bind a TCP port')
      const url = `https://127.0.0.1:${address.port}/`
      await expect(fetchWithWebCa(url, {}, certPath).then((response) => response.text())).resolves.toBe('trusted')
      await expect(fetchWithWebCa(url).then((response) => response.text())).rejects.toThrow()
      await writeFile(certPath, `${await readFile(certPath, 'utf8')}\n`)
      await expect(fetchWithWebCa(url, {}, certPath).then((response) => response.text())).resolves.toBe('trusted')
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
