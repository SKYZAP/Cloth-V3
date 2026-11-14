/*
 * Secrets inside MCP server and provider settings: header values, environment variables and address
 * parameters whose names say they hold one (Authorization, API_KEY, userToken…). The main process keeps
 * them encrypted at rest and hands the app and paired phones a mask instead; a mask sent back unchanged
 * means "keep what's saved".
 */

export const SECRET_MASK = '••••••••'

const SECRET_NAME = /auth|token|key|secret|pass(word|wd)?\b|cookie|session|credential|bearer/i

export const isSecretName = (name: string): boolean => SECRET_NAME.test(name)

/** What the app shows for a secret: the mask, after any scheme ("Bearer ••••••••"). */
export function maskValue(value: string): string {
  if (!value) return value
  const scheme = /^(bearer|basic|token)\s+/i.exec(value)?.[0] ?? ''
  return `${scheme}${SECRET_MASK}`
}

export const isMasked = (value: string): boolean => value.includes(SECRET_MASK)
