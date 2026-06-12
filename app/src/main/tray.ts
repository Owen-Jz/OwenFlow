import { Menu, Tray, app, nativeImage } from 'electron'

export interface TrayCallbacks {
  isEnabled: () => boolean
  onToggleEnabled: (enabled: boolean) => void
  onOpenSettings: () => void
  onOpenHistory: () => void
  onQuit: () => void
}

let tray: Tray | null = null

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

export function createTray(callbacks: TrayCallbacks): Tray {
  tray = new Tray(createMicImage())
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
      { type: 'separator' },
      { label: 'Settings…', click: callbacks.onOpenSettings },
      { label: 'History…', click: callbacks.onOpenHistory },
      { type: 'separator' },
      { label: 'Quit OwenFlow', click: callbacks.onQuit }
    ])
    tray?.setContextMenu(menu)
  }

  rebuildMenu()
  tray.on('double-click', callbacks.onOpenSettings)

  app.on('before-quit', () => {
    tray?.destroy()
    tray = null
  })

  return tray
}
