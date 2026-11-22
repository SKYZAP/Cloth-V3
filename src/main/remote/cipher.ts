import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto'
import { SESSION_INFO, sessionSalt, type SessionCipher } from '@shared/remote'

const TAG = 16

/**
 * The desktop's end of the session cipher, on node:crypto rather than Web Crypto.
 *
 * Web Crypto AES jobs in Electron's main process abort the app (`CipherJob::ToResult ... Assertion
 * failed: errors->Empty()`) whenever the main thread's BoringSSL error queue holds a stale error,
 * which Chromium leaves behind, for example, after a failed `safeStorage.decryptString` (a secret
 * saved under another profile's key). node:crypto's sync cipher has no such check and throws ordinary
 * errors, so a failure here can only drop the connection. Byte-compatible with webCryptoCipher().
 */
export function nodeSessionCipher(deviceKey: Uint8Array, challenge: Uint8Array, clientNonce: Uint8Array): SessionCipher {
  const key = Buffer.from(hkdfSync('sha256', deviceKey, sessionSalt(challenge, clientNonce), SESSION_INFO, 32))
  return {
    encrypt: async (iv, plain) => {
      const c = createCipheriv('aes-256-gcm', key, iv)
      return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])
    },
    decrypt: async (iv, sealed) => {
      if (sealed.length < TAG) throw new Error('Frame too short')
      const d = createDecipheriv('aes-256-gcm', key, iv)
      d.setAuthTag(sealed.subarray(sealed.length - TAG))
      return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()])
    }
  }
}
