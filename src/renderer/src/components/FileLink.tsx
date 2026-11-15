import { createContext, useContext } from 'react'
import clsx from 'clsx'
import { filePathIn, relativeTo } from '@shared/file-links'
import { openWorkspaceFile } from '@/pages/chat/setupNav'

/** Set by a chat with a folder: file paths in its messages open in the side panel's file viewer. */
export const FileLinks = createContext<{ root: string | null } | null>(null)

/** The path relative to the chat's folder that `raw` points at, when it's a file path a click can open. */
export function useFileTarget(raw: string): string | null {
  const ctx = useContext(FileLinks)
  if (!ctx) return null
  const path = filePathIn(raw)
  return path ? relativeTo(ctx.root, path) : null
}

/** Inline code that names a file in the chat's folder: a button that opens it in the file viewer. */
export function FileCode({ text, className }: { text: string; className?: string }) {
  const rel = useFileTarget(text)
  if (!rel) return <code className={className}>{text}</code>
  return (
    <button type="button" onClick={() => openWorkspaceFile(rel)} title={`Open ${rel} in the file viewer`} className={clsx('file-link', className)}>
      <code>{text}</code>
    </button>
  )
}

/** A link in a reply whose address is a file path (relative, absolute or file://). Null when it isn't one. */
export function useFileHref(href: string | undefined): string | null {
  const ctx = useContext(FileLinks)
  if (!ctx || !href || href.startsWith('#') || /^(?:https?|mailto|tel):/i.test(href)) return null
  let decoded = href
  try {
    decoded = decodeURI(href)
  } catch {
    /* use it as written */
  }
  const path = filePathIn(decoded, true)
  return path ? relativeTo(ctx.root, path) : null
}
