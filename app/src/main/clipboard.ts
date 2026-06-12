import { clipboard } from 'electron'

/**
 * Handler body for the "clipboard:write" IPC.
 *
 * The settings/history window is loaded from file:// in the packaged app,
 * which is not a secure context — navigator.clipboard is undefined there —
 * so the renderer copies via this main-process handler instead.
 *
 * Returns true when the text was written, false for non-string payloads.
 */
export function clipboardWrite(text: unknown): boolean {
  if (typeof text !== 'string') return false
  clipboard.writeText(text)
  return true
}
