/**
 * Visual QA harness for the settings window — defines a complete
 * `window.owenflow` mock so app/src/renderer/settings.html can be loaded in a
 * plain browser (no Electron, no preload) for screenshots.
 *
 * Usage (from app/):
 *   1. Temporarily add, ABOVE the module script tag in src/renderer/settings.html:
 *        <script src="../../docs/mockups/settings-harness-stub.js"></script>
 *   2. `npm run dev` (or `npx vite dev` per electron-vite renderer) and open
 *      http://localhost:5173/settings.html — or `npm run build` and serve
 *      out/renderer/ with the stub injected into the built settings.html.
 *   3. Remove the tag before committing. This file is NOT bundled.
 *
 * Classic script (no modules) so it executes before the settings module loads.
 */
/* eslint-disable */
;(function () {
  'use strict'

  var now = Date.now()
  var MIN = 60 * 1000
  var HOUR = 60 * MIN
  var DAY = 24 * HOUR

  // Every field of OwenFlowSettings, realistic defaults.
  var settings = {
    hotkey: 'CtrlWin',
    mode: 'hold',
    flowMode: 'vibe',
    model: 'large-v3-turbo',
    language: '',
    cleanupEnabled: true,
    cleanupIntensity: 'medium',
    cleanupProvider: 'groq',
    minimaxApiKey: '',
    minimaxGroupId: '',
    groqApiKey: 'gsk_test_1234567890',
    groqModel: 'llama-3.3-70b-versatile',
    dictionary: ['Hermes', 'Qdrant', 'owen flow=>OwenFlow'],
    snippets: ['sign off email=>Best,\\nOwen'],
    translateTarget: 'English',
    sessionTones: ['client=>formal', 'notes=>normal'],
    activeSession: '',
    appProfilesEnabled: true,
    profiles: [
      {
        match: ['Code', 'Cursor'],
        flowMode: 'vibe',
        stripTrailingPeriod: true,
        noAutoCapitalize: true,
        singleLine: false,
        replacements: ['fn=>function'],
        promptRule: 'Use imperative mood'
      }
    ],
    digestEnabled: true,
    digestHour: 18,
    digestThemes: false,
    commandEnabled: true,
    commandHotkey: 'RightAlt',
    continuousMode: false,
    zealEndpoint: 'https://173-212-225-7.sslip.io/api/voice',
    zealApiKey: 'zeal-voice-key',
    zealSpeakReplies: false,
    launchOnStartup: true,
    theme: 'dark',
    pillPosition: 'bottom-center'
  }

  // ~8 realistic entries spread over today + yesterday, newest first.
  var historyEntries = [
    {
      ts: now - 4 * MIN,
      raw: 'hey can you push the fix to staging and ping me when the build is green',
      final: 'Hey, can you push the fix to staging and ping me when the build is green?',
      durationMs: 6200,
      app: 'Cursor',
      tags: ['work'],
      mode: 'vibe',
      folder: 'Work'
    },
    {
      ts: now - 22 * MIN,
      raw: 'sounds good lets move standup to ten thirty tomorrow i have a call with the nomba team',
      final: "Sounds good — let's move standup to 10:30 tomorrow, I have a call with the Nomba team.",
      durationMs: 7400,
      app: 'Slack',
      tags: ['work', 'meetings'],
      mode: 'normal'
    },
    {
      ts: now - 1 * HOUR,
      raw: 'summarize this thread and draft a reply saying we will ship the invoice flow by friday',
      final: "Summarize this thread and draft a reply saying we'll ship the invoice flow by Friday.",
      durationMs: 5900,
      app: 'Chrome',
      tags: ['email'],
      mode: 'vibe'
    },
    {
      ts: now - 2 * HOUR,
      raw: 'add a todo refactor the sidecar restart logic so it retries with backoff',
      final: 'Add a TODO: refactor the sidecar restart logic so it retries with backoff.',
      durationMs: 4100,
      app: 'Cursor',
      tags: ['todo'],
      mode: 'normal',
      folder: 'Work'
    },
    {
      ts: now - 3 * HOUR,
      raw: 'dear doctor egbagba thank you for the update i will review the results tonight',
      final: 'Dear Dr. Egbagba, thank you for the update — I will review the results tonight.',
      durationMs: 8200,
      app: 'Outlook',
      tags: ['email', 'family'],
      mode: 'formal'
    },
    {
      ts: now - 5 * HOUR,
      raw: 'note to self check the resend webhook secret in the coolify env not the vps env file',
      final: 'Note to self: check the Resend webhook secret in the Coolify env, not the VPS env file.',
      durationMs: 5100,
      app: 'Notepad',
      tags: ['notes'],
      mode: 'normal'
    },
    {
      ts: now - DAY - 1 * HOUR,
      raw: 'draft a landing page hero for the per invoice virtual accounts idea',
      final: 'Draft a landing page hero for the per-invoice virtual accounts idea.',
      durationMs: 6800,
      app: 'Chrome',
      tags: ['work'],
      mode: 'vibe',
      folder: 'Nomba'
    },
    {
      ts: now - DAY - 4 * HOUR,
      raw: 'remind me to send mom the blog analytics screenshot on sunday',
      final: 'Remind me to send Mom the blog analytics screenshot on Sunday.',
      durationMs: 3900,
      app: 'Slack',
      tags: ['family'],
      mode: 'normal'
    }
  ]

  function resolve(value) {
    return Promise.resolve(value)
  }
  /** A subscription function that returns an unsubscribe fn. */
  function subscription() {
    return function () {
      return function () {}
    }
  }

  window.owenflow = {
    settings: {
      get: function () {
        return resolve(Object.assign({}, settings))
      },
      set: function (patch) {
        Object.assign(settings, patch || {})
        return resolve(Object.assign({}, settings))
      }
    },
    history: {
      list: function (limit) {
        return resolve(historyEntries.slice(0, limit || 200))
      },
      clear: function () {
        historyEntries = []
        return resolve(undefined)
      },
      updateTags: function (ts, tags) {
        for (var i = 0; i < historyEntries.length; i++) {
          if (historyEntries[i].ts === ts) historyEntries[i].tags = tags
        }
        return resolve(true)
      },
      tags: function () {
        var counts = {}
        historyEntries.forEach(function (e) {
          ;(e.tags || []).forEach(function (t) {
            counts[t] = (counts[t] || 0) + 1
          })
        })
        return resolve(
          Object.keys(counts).map(function (tag) {
            return { tag: tag, count: counts[tag] }
          })
        )
      },
      setFolder: function (ts, folder) {
        for (var i = 0; i < historyEntries.length; i++) {
          if (historyEntries[i].ts === ts) historyEntries[i].folder = folder || undefined
        }
        return resolve(true)
      },
      folders: function () {
        var counts = {}
        historyEntries.forEach(function (e) {
          if (e.folder) counts[e.folder] = (counts[e.folder] || 0) + 1
        })
        return resolve(
          Object.keys(counts)
            .sort()
            .map(function (folder) {
              return { folder: folder, count: counts[folder] }
            })
        )
      },
      renameFolder: function (from, to) {
        var n = 0
        historyEntries.forEach(function (e) {
          if (e.folder === from) {
            e.folder = to
            n++
          }
        })
        return resolve(n)
      },
      deleteFolder: function (name) {
        var n = 0
        historyEntries.forEach(function (e) {
          if (e.folder === name) {
            e.folder = undefined
            n++
          }
        })
        return resolve(n)
      }
    },
    pill: {
      onState: subscription(),
      onLevel: subscription()
    },
    recorder: {
      onStart: subscription(),
      onStop: subscription(),
      sendData: function () {},
      sendSegment: function () {},
      sendDone: function () {},
      sendError: function () {},
      sendLevel: function () {}
    },
    ui: {
      onShowTab: subscription()
    },
    clipboard: {
      write: function () {
        return resolve(true)
      }
    },
    cleanup: {
      benchmark: function () {
        return resolve([
          { provider: 'groq', ok: true, ms: 640 },
          { provider: 'minimax', ok: true, ms: 2310 }
        ])
      }
    },
    debug: {
      simulateDictation: function () {
        return resolve(undefined)
      }
    },
    appinfo: {
      get: function () {
        return resolve({
          version: '1.6.0',
          dataDir: 'C:\\Users\\owen\\AppData\\Roaming\\OwenFlow'
        })
      }
    },
    sidecar: {
      get: function () {
        return resolve({ status: 'ready', detail: 'whisper "large-v3-turbo"' })
      },
      onStatus: subscription()
    },
    apps: {
      detect: function () {
        return resolve(null)
      }
    },
    learn: {
      propose: function () {
        return resolve([])
      }
    },
    tts: {
      onSpeak: subscription()
    },
    win: {
      minimize: function () {},
      maximize: function () {},
      close: function () {}
    },
    dictation: {
      start: function () {
        return resolve(undefined)
      }
    }
  }
})()
