import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          recorder: resolve(__dirname, 'src/renderer/recorder.html'),
          meeting: resolve(__dirname, 'src/renderer/meeting.html'),
          pill: resolve(__dirname, 'src/renderer/pill.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html')
        }
      }
    }
  }
})
