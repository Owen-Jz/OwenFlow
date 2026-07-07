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
    pillPosition: 'bottom-center',
    meetingAutoDetect: true,
    contextAwareness: false
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
      // Dictated DURING a meeting — main auto-tags these 'meeting', and the
      // History chip for that tag gets the tiny red-dot treatment.
      ts: now - 40 * MIN,
      raw: 'action item send tunde the settlement dashboard link after this call',
      final: 'Action item: send Tunde the settlement dashboard link after this call.',
      durationMs: 4600,
      app: 'Slack',
      tags: ['meeting', 'work'],
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

  // ── Meetings mock ─────────────────────────────────────────────────────────
  // Open settings.html with ?meeting=active to screenshot the live-recording
  // variant (pulsing card on Meetings, pill on Home, End-meeting button).
  var MEETING_ACTIVE = /[?&]meeting=active/.test(location.search)

  // Yesterday, 1 hour, summarized later (updatedAt > recorded); plus a 12-min
  // meeting today without a summary (updatedAt ≈ ended, so Updated shows).
  var yesterdayStart = now - DAY - 2 * HOUR
  var todayStart = now - 3 * HOUR
  var meetingMetas = [
    {
      id: '2026-07-05-101400',
      startedAt: todayStart,
      endedAt: todayStart + 12 * MIN,
      durationMs: 12 * MIN,
      words: 1618,
      updatedAt: todayStart + 12 * MIN
    },
    {
      id: '2026-07-04-140000',
      startedAt: yesterdayStart,
      endedAt: yesterdayStart + HOUR,
      durationMs: HOUR,
      words: 8412,
      summary:
        'Weekly product sync with the Nomba team.\n' +
        '• Locked the per-invoice virtual accounts flow for the July demo; webhook reconciliation maps accountRef to aliasAccountReference.\n' +
        '• Owen ships the settlement dashboard by Friday; Tunde owns sandbox credentials and the transfer smoke test.\n' +
        '• Open question: whether expectedAmount should stay unset so partial payments still reconcile.\n' +
        'Next check-in Thursday 10:30.',
      updatedAt: now - 5 * HOUR
    }
  ]

  var meetingTranscripts = {
    '2026-07-05-101400': [
      { t: todayStart + 5 * 1000, speaker: 'them', text: 'Morning Owen, can you hear me okay?' },
      { t: todayStart + 12 * 1000, speaker: 'you', text: 'Loud and clear. I wanted to run through the invoice webhook quickly before standup.' },
      { t: todayStart + 40 * 1000, speaker: 'you', text: 'The signature is an HMAC over the nine-field colon string, not the raw body — that was the bug.' },
      { t: todayStart + 70 * 1000, speaker: 'them', text: 'That explains the 401s we saw on Friday.' },
      { t: todayStart + 95 * 1000, speaker: 'them', text: '[inaudible]' },
      { t: todayStart + 110 * 1000, speaker: 'them', text: 'Sorry, my mic cut out — I said the sandbox creds landed in spam, check that folder.' },
      { t: todayStart + 140 * 1000, speaker: 'you', text: 'Found them. I will rerun the transfer smoke test right after this call and ping you when it is green.' },
      { t: todayStart + 11 * MIN, speaker: 'them', text: 'Perfect. Let us pick the rest up at standup.' }
    ],
    '2026-07-04-140000': [
      { t: yesterdayStart + 10 * 1000, speaker: 'them', text: 'Alright, weekly sync. Demo day is on the nineteenth so let us lock scope today.' },
      { t: yesterdayStart + 45 * 1000, speaker: 'you', text: 'Agreed. My proposal is we ship per-invoice virtual accounts only — one account per invoice, auto-reconciled off the webhook.' },
      { t: yesterdayStart + 90 * 1000, speaker: 'you', text: 'Rent and school fees stay post-hackathon; the scoring had SME per-invoice ahead anyway.' },
      { t: yesterdayStart + 3 * MIN, speaker: 'them', text: 'Works for me. What is left on the dashboard?' },
      { t: yesterdayStart + 4 * MIN, speaker: 'you', text: 'Settlement view and the reconciliation table. I can have both by Friday.' },
      { t: yesterdayStart + 30 * MIN, speaker: 'them', text: '[inaudible]' },
      { t: yesterdayStart + 31 * MIN, speaker: 'them', text: 'I was asking whether we leave expectedAmount unset so partial payments still reconcile.' },
      { t: yesterdayStart + 33 * MIN, speaker: 'you', text: 'Yes — leave it unset. If we set it the sender bank rejects mismatches and we lose the partial-payment story.' },
      { t: yesterdayStart + 58 * MIN, speaker: 'them', text: 'Good session. Next check-in Thursday ten thirty.' }
    ]
  }

  var meetingStateInfo = {
    active: MEETING_ACTIVE,
    startedAt: MEETING_ACTIVE ? now - 42 * 1000 : null
  }
  var meetingStateCbs = []
  function pushMeetingState() {
    var snapshot = { active: meetingStateInfo.active, startedAt: meetingStateInfo.startedAt }
    meetingStateCbs.forEach(function (cb) {
      cb(snapshot)
    })
  }
  // Mirror the backend: a running meeting is already listable (meta written
  // at start, no endedAt yet). The renderer folds it into the live card.
  if (MEETING_ACTIVE) {
    meetingMetas.unshift({
      id: '2026-07-05-131800',
      startedAt: meetingStateInfo.startedAt,
      words: 96,
      updatedAt: now - 5 * 1000
    })
  }

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
    },
    meetings: {
      start: function () {
        if (meetingStateInfo.active) return resolve(false)
        meetingStateInfo = { active: true, startedAt: Date.now() }
        meetingMetas.unshift({
          id: 'live-' + meetingStateInfo.startedAt,
          startedAt: meetingStateInfo.startedAt,
          words: 0,
          updatedAt: meetingStateInfo.startedAt
        })
        pushMeetingState()
        return resolve(true)
      },
      stop: function () {
        if (meetingStateInfo.active) {
          var startedAt = meetingStateInfo.startedAt
          for (var i = 0; i < meetingMetas.length; i++) {
            if (meetingMetas[i].startedAt === startedAt && meetingMetas[i].endedAt == null) {
              meetingMetas[i].endedAt = Date.now()
              meetingMetas[i].durationMs = meetingMetas[i].endedAt - startedAt
              meetingMetas[i].words = meetingMetas[i].words || 96
              meetingMetas[i].updatedAt = meetingMetas[i].endedAt
            }
          }
          meetingStateInfo = { active: false, startedAt: null }
          pushMeetingState()
        }
        return resolve(undefined)
      },
      state: function () {
        return resolve({ active: meetingStateInfo.active, startedAt: meetingStateInfo.startedAt })
      },
      onState: function (cb) {
        meetingStateCbs.push(cb)
        return function () {
          meetingStateCbs = meetingStateCbs.filter(function (c) {
            return c !== cb
          })
        }
      },
      list: function () {
        return resolve(meetingMetas.slice())
      },
      get: function (id) {
        var meta = null
        for (var i = 0; i < meetingMetas.length; i++) {
          if (meetingMetas[i].id === id) meta = meetingMetas[i]
        }
        return resolve({
          meta: Object.assign({}, meta),
          entries: (meetingTranscripts[id] || []).slice()
        })
      },
      remove: function (id) {
        meetingMetas = meetingMetas.filter(function (m) {
          return m.id !== id
        })
        return resolve(undefined)
      },
      summarize: function (id) {
        var meta = null
        for (var i = 0; i < meetingMetas.length; i++) {
          if (meetingMetas[i].id === id) meta = meetingMetas[i]
        }
        if (!meta) return resolve('')
        if (!meta.summary) {
          meta.summary =
            'Quick pre-standup sync on the invoice webhook.\n' +
            '• Root cause of the Friday 401s: signature is HMAC over the 9-field colon string, not the raw body.\n' +
            '• Sandbox credentials were in spam; Owen reruns the transfer smoke test after the call.\n' +
            'Follow-ups move to standup.'
          meta.updatedAt = Date.now()
        }
        var summary = meta.summary
        // Small delay so the "Summarizing…" spinner state is screenshotable.
        return new Promise(function (res) {
          setTimeout(function () {
            res(summary)
          }, 900)
        })
      },
      rename: function (id, title) {
        for (var i = 0; i < meetingMetas.length; i++) {
          if (meetingMetas[i].id === id) {
            var trimmed = (title || '').trim()
            if (trimmed) meetingMetas[i].title = trimmed
            else delete meetingMetas[i].title
            meetingMetas[i].updatedAt = Date.now()
            return resolve(true)
          }
        }
        return resolve(false)
      },
      sendActions: function (id) {
        return new Promise(function (res) {
          setTimeout(function () {
            // Mark actionsSentAt on the mock meta so re-open shows Re-send label.
            for (var i = 0; i < meetingMetas.length; i++) {
              if (meetingMetas[i].id === id) {
                meetingMetas[i].actionsSentAt = Date.now()
                meetingMetas[i].updatedAt = Date.now()
              }
            }
            res({ items: ['Ship the webhook fix'], sent: true, reply: 'Filed 1 task.' })
          }, 700)
        })
      }
    },
    meetingCapture: {
      onStart: subscription(),
      onStop: subscription(),
      sendSegment: function () {},
      sendStopped: function () {},
      sendError: function () {}
    }
  }
})()
