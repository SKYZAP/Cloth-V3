// Trust the operating system's certificate store for HTTPS, on top of Node's bundled roots.
// Antivirus and corporate proxies (Norton, Zscaler, …) re-sign HTTPS with a root that only the OS store
// holds, which fails downloads with "unable to verify the first certificate". Import this first in any
// script that downloads (electron-builder, sidecars, Gradle wrappers): it covers this process and,
// through NODE_OPTIONS, every Node process it starts. `.npmrc` does the same for npm scripts.
import tls from 'node:tls'

if (typeof tls.setDefaultCACertificates === 'function') {
  const roots = new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])
  tls.setDefaultCACertificates([...roots])
}

const flag = '--use-system-ca'
const opts = process.env.NODE_OPTIONS ?? ''
if (!opts.split(/\s+/).includes(flag)) process.env.NODE_OPTIONS = `${opts} ${flag}`.trim()
