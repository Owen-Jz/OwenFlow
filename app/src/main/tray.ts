import { Menu, Tray, app, nativeImage } from 'electron'
import trayIconPath from '../../resources/icon.png?asset'
import type { FlowMode, PillPosition } from '../shared/types'

export interface TrayCallbacks {
  isEnabled: () => boolean
  onToggleEnabled: (enabled: boolean) => void
  getFlowMode: () => FlowMode
  onSetFlowMode: (mode: FlowMode) => void
  /** Meeting recorder state for the Start/End meeting toggle item. */
  isMeetingActive: () => boolean
  /** Elapsed label for the active meeting, e.g. "0:42:13" (meeting-channel formats it). */
  getMeetingElapsed: () => string
  /** Toggle the meeting recorder (index.ts routes to start/stop by state). */
  onToggleMeeting: () => void
  onOpenSettings: () => void
  onOpenHistory: () => void
  onShowDigest: () => void
  onQuit: () => void
  /** Configured session labels (from sessionTones), for the Session submenu. */
  getSessions: () => string[]
  getActiveSession: () => string
  onSetActiveSession: (label: string) => void
  /** Pill overlay position (tray-driven, no settings UI; applies on next pill show). */
  getPillPosition: () => PillPosition
  onSetPillPosition: (position: PillPosition) => void
}

const FLOW_MODE_LABELS: Array<{ value: FlowMode; label: string }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'vibe', label: 'Vibe Coding' },
  { value: 'formal', label: 'Formal' },
  { value: 'translate', label: 'Translate' }
]

const PILL_POSITION_LABELS: Array<{ value: PillPosition; label: string }> = [
  { value: 'bottom-center', label: 'Bottom center' },
  { value: 'top-center', label: 'Top center' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' }
]

let tray: Tray | null = null
let rebuild: (() => void) | null = null

/** Re-render the tray menu (e.g. after a settings change from the UI). */
export function refreshTrayMenu(): void {
  rebuild?.()
}

/**
 * Draw a simple white microphone glyph into a raw BGRA bitmap so we don't
 * need any image asset on disk. 32x32, scaled down by the OS as needed.
 */
function createMicImage(size = 32): Electron.NativeImage {
  const buf = Buffer.alloc(size * size * 4, 0)
  const s = size / 32 // design coordinates on a 32px grid

  const put = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    buf[i] = 255 // B
    buf[i + 1] = 255 // G
    buf[i + 2] = 255 // R
    buf[i + 3] = 255 // A
  }

  const inCapsule = (x: number, y: number): boolean => {
    // mic body: capsule centered at x=16, from y=4 to y=17, radius 5
    const cx = 16 * s
    const r = 5 * s
    const top = 4 * s + r
    const bottom = 17 * s - r
    const px = x + 0.5
    const py = y + 0.5
    if (py >= top && py <= bottom) return Math.abs(px - cx) <= r
    const cy = py < top ? top : bottom
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
  }

  const inArc = (x: number, y: number): boolean => {
    // U-shaped cradle: ring centered (16,15), outer r 9.5, inner r 7, lower half only
    const cx = 16 * s
    const cy = 15 * s
    const px = x + 0.5
    const py = y + 0.5
    if (py < cy) return false
    const d = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2)
    return d <= 9.5 * s && d >= 7 * s
  }

  const inStem = (x: number, y: number): boolean => {
    const px = x + 0.5
    const py = y + 0.5
    return Math.abs(px - 16 * s) <= 1.25 * s && py >= 24 * s && py <= 28 * s
  }

  const inBase = (x: number, y: number): boolean => {
    const px = x + 0.5
    const py = y + 0.5
    return Math.abs(px - 16 * s) <= 5.5 * s && py >= 28 * s && py <= 30 * s
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inCapsule(x, y) || inArc(x, y) || inStem(x, y) || inBase(x, y)) put(x, y)
    }
  }

  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

/**
 * Branded tray icon from resources/icon.png with 1x/2x representations for
 * crisp rendering on any DPI; falls back to the drawn glyph if missing.
 */
function createTrayIcon(): Electron.NativeImage {
  const source = nativeImage.createFromPath(trayIconPath)
  if (source.isEmpty()) return createMicImage()
  const icon = nativeImage.createEmpty()
  icon.addRepresentation({
    scaleFactor: 1,
    buffer: source.resize({ width: 16, height: 16, quality: 'best' }).toPNG()
  })
  icon.addRepresentation({
    scaleFactor: 2,
    buffer: source.resize({ width: 32, height: 32, quality: 'best' }).toPNG()
  })
  return icon
}

export function createTray(callbacks: TrayCallbacks): Tray {
  tray = new Tray(createTrayIcon())
  tray.setToolTip('OwenFlow — push-to-talk dictation')

  const rebuildMenu = (): void => {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Enabled',
        type: 'checkbox',
        checked: callbacks.isEnabled(),
        click: (item) => {
          callbacks.onToggleEnabled(item.checked)
        }
      },
      {
        // Meeting recorder toggle. The elapsed time is a rebuild-time snapshot
        // (the menu rebuilds on every meeting state change, not per second) —
        // it orients "how long has this been running", not a live stopwatch.
        label: callbacks.isMeetingActive()
          ? `End meeting (${callbacks.getMeetingElapsed()})`
          : 'Start meeting',
        click: callbacks.onToggleMeeting
      },
      { type: 'separator' },
      {
        label: 'Mode',
        submenu: FLOW_MODE_LABELS.map(({ value, label }) => ({
          label,
          type: 'radio' as const,
          checked: callbacks.getFlowMode() === value,
          click: () => callbacks.onSetFlowMode(value)
        }))
      },
      {
        label: 'Session',
        submenu: [
          {
            label: 'None',
            type: 'radio' as const,
            checked: !callbacks.getActiveSession(),
            click: () => callbacks.onSetActiveSession('')
          },
          ...callbacks.getSessions().map((label) => ({
            label,
            type: 'radio' as const,
            checked: callbacks.getActiveSession() === label,
            click: () => callbacks.onSetActiveSession(label)
          }))
        ]
      },
      {
        // Wispr parity win: their pill is locked bottom-center. setPillState
        // repositions on every show, so a pick here applies next pill show.
        label: 'Pill position',
        submenu: PILL_POSITION_LABELS.map(({ value, label }) => ({
          label,
          type: 'radio' as const,
          checked: callbacks.getPillPosition() === value,
          click: () => callbacks.onSetPillPosition(value)
        }))
      },
      { type: 'separator' },
      { label: 'Settings…', click: callbacks.onOpenSettings },
      { label: 'History…', click: callbacks.onOpenHistory },
      { label: "Today's digest", click: callbacks.onShowDigest },
      { type: 'separator' },
      { label: 'Quit OwenFlow', click: callbacks.onQuit }
    ])
    tray?.setContextMenu(menu)
  }

  rebuild = rebuildMenu
  rebuildMenu()
  tray.on('double-click', callbacks.onOpenSettings)

  app.on('before-quit', () => {
    tray?.destroy()
    tray = null
    rebuild = null
  })

  return tray
}
