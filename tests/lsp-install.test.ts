import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { clangdAsset, installedJdtls, installedProgram, installServer, jdtlsConfigName, jdtlsJavaArgs, readManifest, rustAsset, uninstallServer } from '../src/main/agent/lsp-install'
import { languageServers } from '../src/main/onboarding'

const rustRelease = {
  tag_name: '2026-11-10',
  assets: ['rust-analyzer-x86_64-pc-windows-msvc.zip', 'rust-analyzer-aarch64-apple-darwin.gz', 'rust-analyzer-x86_64-apple-darwin.gz', 'rust-analyzer-x86_64-unknown-linux-gnu.gz', 'rust-analyzer-aarch64-unknown-linux-gnu.gz'].map((name) => ({ name, browser_download_url: `https://example.test/${name}` }))
}
const clangdRelease = {
  tag_name: '19.1.2',
  assets: ['clangd-windows-19.1.2.zip', 'clangd-mac-19.1.2.zip', 'clangd-linux-19.1.2.zip', 'clangd_indexing_tools-linux-19.1.2.zip'].map((name) => ({ name, browser_download_url: `https://example.test/${name}` }))
}

describe('installing language servers', () => {
  it('picks the build for each computer', () => {
    expect(rustAsset(rustRelease, 'win32', 'x64')?.name).toBe('rust-analyzer-x86_64-pc-windows-msvc.zip')
    expect(rustAsset(rustRelease, 'darwin', 'arm64')?.name).toBe('rust-analyzer-aarch64-apple-darwin.gz')
    expect(rustAsset(rustRelease, 'linux', 'arm64')?.name).toBe('rust-analyzer-aarch64-unknown-linux-gnu.gz')
    expect(rustAsset(rustRelease, 'linux', 'ia32')).toBeNull()
    expect(clangdAsset(clangdRelease, 'win32', 'x64')?.name).toBe('clangd-windows-19.1.2.zip')
    expect(clangdAsset(clangdRelease, 'darwin', 'arm64')?.name).toBe('clangd-mac-19.1.2.zip')
    expect(clangdAsset(clangdRelease, 'linux', 'x64')?.name).toBe('clangd-linux-19.1.2.zip')
    // No Linux build for ARM: the person installs it from their package manager.
    expect(clangdAsset(clangdRelease, 'linux', 'arm64')).toBeNull()
    expect(jdtlsConfigName('win32', 'x64')).toBe('config_win')
    expect(jdtlsConfigName('darwin', 'arm64')).toBe('config_mac_arm')
    expect(jdtlsConfigName('linux', 'x64')).toBe('config_linux')
  })

  it('downloads rust-analyzer into its own folder, records what to run, and removes it', async () => {
    const servers = mkdtempSync(join(tmpdir(), 'cloth-lsp-servers-'))
    const binary = Buffer.from('#!/bin/sh\necho rust-analyzer\n')
    const urls: string[] = []
    const fetchMock = (async (url: string) => {
      urls.push(String(url))
      if (String(url).includes('api.github.com')) return new Response(JSON.stringify(rustRelease))
      const body = gzipSync(binary)
      return new Response(body, { headers: { 'content-length': String(body.length) } })
    }) as typeof fetch
    const steps: string[] = []
    const m = await installServer(servers, 'rust', { fetch: fetchMock, findOnPath: () => null, platform: 'linux', arch: 'x64', onProgress: (t) => steps.push(t) })
    expect(m).toMatchObject({ version: '2026-11-10', program: 'rust-analyzer' })
    expect(urls[1]).toBe('https://example.test/rust-analyzer-x86_64-unknown-linux-gnu.gz')
    const program = installedProgram(servers, 'rust')!
    expect(readFileSync(program)).toEqual(binary)
    expect(steps).toContain('Downloading rust-analyzer')
    expect(steps.at(-1)).toBe('Installed')
    // Only the finished copy is left: no download, no staging folder.
    expect(existsSync(join(servers, 'rust.new'))).toBe(false)
    expect(existsSync(join(servers, 'rust', 'rust-analyzer-x86_64-unknown-linux-gnu.gz'))).toBe(false)
    await uninstallServer(servers, 'rust')
    expect(installedProgram(servers, 'rust')).toBeNull()
  })

  it('keeps the old copy when a download fails', async () => {
    const servers = mkdtempSync(join(tmpdir(), 'cloth-lsp-servers-'))
    mkdirSync(join(servers, 'cpp', 'clangd', 'bin'), { recursive: true })
    writeFileSync(join(servers, 'cpp', 'clangd', 'bin', 'clangd'), 'old')
    writeFileSync(join(servers, 'cpp', 'cloth-server.json'), JSON.stringify({ version: '18', program: 'clangd/bin/clangd', installedAt: 1 }))
    const failing = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    await expect(installServer(servers, 'cpp', { fetch: failing, findOnPath: () => null, platform: 'linux', arch: 'x64' })).rejects.toThrow(/release/)
    expect(readManifest(servers, 'cpp')?.version).toBe('18')
    expect(existsSync(join(servers, 'cpp.new'))).toBe(false)
  })

  it('builds gopls with go install into its folder, and needs Go to do it', async () => {
    const servers = mkdtempSync(join(tmpdir(), 'cloth-lsp-servers-'))
    await expect(installServer(servers, 'go', { findOnPath: () => null, platform: 'linux' })).rejects.toThrow(/Go isn't installed/)
    let ran: { cmd: string; args: string[]; gobin?: string } | null = null
    await installServer(servers, 'go', {
      findOnPath: (p) => (p === 'go' ? '/usr/local/go/bin/go' : null),
      platform: 'linux',
      run: async (cmd, args, env) => {
        ran = { cmd, args, gobin: env.GOBIN }
        writeFileSync(join(env.GOBIN!, 'gopls'), 'bin')
      }
    })
    expect(ran).toMatchObject({ cmd: '/usr/local/go/bin/go', args: ['install', 'golang.org/x/tools/gopls@latest'] })
    expect(ran!.gobin).toBe(join(servers, 'go.new'))
    expect(installedProgram(servers, 'go')).toBe(join(servers, 'go', 'gopls'))
  })

  it('starts an installed jdtls straight on Java, with its workspace outside the project', () => {
    const servers = mkdtempSync(join(tmpdir(), 'cloth-lsp-servers-'))
    mkdirSync(join(servers, 'java', 'plugins'), { recursive: true })
    mkdirSync(join(servers, 'java', 'config_linux'))
    writeFileSync(join(servers, 'java', 'plugins', 'org.eclipse.equinox.launcher_1.7.0.jar'), '')
    writeFileSync(join(servers, 'java', 'cloth-server.json'), JSON.stringify({ version: '1.7.0', launcher: 'plugins/org.eclipse.equinox.launcher_1.7.0.jar', configuration: 'config_linux', installedAt: 1 }))
    const jdtls = installedJdtls(servers)!
    const args = jdtlsJavaArgs(jdtls, '/data/ws')
    expect(args).toEqual(expect.arrayContaining(['-jar', jdtls.launcher, '-configuration', jdtls.configuration, '-data', '/data/ws']))
    expect(args.indexOf('-jar')).toBeGreaterThan(args.indexOf('--add-modules=ALL-SYSTEM'))
  })

  it('says per language whether the server ships, is installed, is on this PC, or can be installed', () => {
    const servers = mkdtempSync(join(tmpdir(), 'cloth-lsp-servers-'))
    mkdirSync(join(servers, 'rust'), { recursive: true })
    writeFileSync(join(servers, 'rust', 'rust-analyzer'), '')
    writeFileSync(join(servers, 'rust', 'cloth-server.json'), JSON.stringify({ version: '2026-11-10', program: 'rust-analyzer', installedAt: 1 }))
    const noJava = () => null
    const byId = Object.fromEntries(languageServers(['python', 'rust', 'cpp', 'java', 'ruby'], servers, noJava).map((s) => [s.id, s]))
    expect(byId.python).toMatchObject({ status: 'bundled' })
    expect(byId.rust).toMatchObject({ status: 'installed', version: '2026-11-10', installable: true })
    expect(byId.ruby).toMatchObject({ status: 'none' })
    // Not on this PC in the test environment: installable, and jdtls says it needs Java.
    if (byId.cpp.status === 'missing') expect(byId.cpp).toMatchObject({ installable: true, needs: null })
    if (byId.java.status === 'missing') expect(byId.java).toMatchObject({ installable: true, needs: { name: 'Java 21 or newer' } })
    // Without Cloth's folder (older callers), nothing is offered for install.
    expect(languageServers(['cpp'], undefined, noJava)[0].installable ?? false).toBe(false)
  })
})
