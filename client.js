/**
 * Pomodoro Timer — Client half.
 *
 * Two surfaces over one shared countdown:
 *
 *  - a floating window in `shell.overlay` (root scope), so the timer stays
 *    visible with or without an open session: drag it, collapse it to a chip,
 *    or open its preferences;
 *  - an optional ambient pill in `conversation.composer.dock`, off by a
 *    preference when the floating window is enough.
 *
 * The countdown is derived from an `endsAt` timestamp and persisted in
 * localStorage, so a reload, a closed tab, or a throttled background tab
 * cannot drift it. Everything is plain React from the loader's module table:
 * no Harness Client package is imported, and every color comes from a
 * `--dsw-alias-*` theme token.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-pomodoro',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'pomodoro'
    /** Durable timer state and preferences. */
    const STORAGE_KEY = 'dsh:pomodoro:v1'
    /** Floating-window position, kept apart from the timer itself. */
    const WINDOW_KEY = 'dsh:pomodoro:window:v1'
    /** Displayed phases; the same keys hold each phase's length in minutes. */
    const PHASES = ['focus', 'short', 'long']
    /** Readout backstop; the exact wake timeout handles phase completion. */
    const TICK_MS = 250
    /** Longest delay setTimeout accepts without overflow. */
    const MAX_TIMEOUT = 2147483647

    /** English copy; the Chinese dictionary carries the same keys. */
    const EN = {
      pluginName: 'Pomodoro Timer',
      focus: 'Focus',
      short: 'Break',
      long: 'Long break',
      start: 'Start',
      pause: 'Pause',
      startHint: 'Start the focus timer',
      pauseHint: 'Pause the timer',
      skip: 'Skip this phase',
      settings: 'Pomodoro settings',
      collapse: 'Collapse to a floating timer',
      chipHint: 'Click to expand · double-click to start or pause · drag to move',
      doubleClickHint: 'Double-click to start or pause',
      focusLength: 'Focus length',
      shortLength: 'Short break',
      longLength: 'Long break',
      rounds: 'Rounds before a long break',
      autoStart: 'Auto-start the next phase',
      sound: 'Chime when a phase ends',
      floatToggle: 'Show the floating timer',
      dockToggle: 'Also show under the composer',
      minutes: 'min',
      roundsUnit: 'rounds',
      resetPhase: 'Reset phase',
      restoreDefaults: 'Restore defaults',
      focusDone: 'Focus finished, take a break.',
      breakDone: 'Break finished, back to focus.',
    }

    /** Chinese copy. */
    const ZH = {
      pluginName: '番茄时钟',
      focus: '专注',
      short: '短休息',
      long: '长休息',
      start: '开始',
      pause: '暂停',
      startHint: '开始专注计时',
      pauseHint: '暂停计时',
      skip: '跳过当前阶段',
      settings: '番茄时钟设置',
      collapse: '收起为悬浮球',
      chipHint: '单击展开 · 双击开始/暂停 · 拖动移动',
      doubleClickHint: '双击开始/暂停',
      focusLength: '专注时长',
      shortLength: '短休息时长',
      longLength: '长休息时长',
      rounds: '长休息前轮数',
      autoStart: '自动开始下一阶段',
      sound: '阶段结束时提示音',
      floatToggle: '显示悬浮窗',
      dockToggle: '输入框下方也显示一条',
      minutes: '分钟',
      roundsUnit: '轮',
      resetPhase: '重置本阶段',
      restoreDefaults: '恢复默认',
      focusDone: '专注结束，休息一下吧。',
      breakDone: '休息结束，继续专注。',
    }

    /** Bounds shared by normalization and the number fields. */
    const LIMITS = {
      focus: [1, 180],
      short: [1, 60],
      long: [1, 120],
      rounds: [1, 8],
    }

    const defaultSettings = () => ({
      focus: 25,
      short: 5,
      long: 15,
      rounds: 4,
      autoStart: true,
      sound: true,
      float: true,
      dock: false,
    })

    /** Clamp one numeric preference without trusting stored or typed input. */
    function clampInt(value, min, max, fallback) {
      const number = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(number)) return fallback
      return Math.min(max, Math.max(min, Math.round(number)))
    }

    /** Coerce a persisted settings object into the shape this version reads. */
    function normalizeSettings(raw) {
      const base = defaultSettings()
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      return {
        focus: clampInt(source.focus, LIMITS.focus[0], LIMITS.focus[1], base.focus),
        short: clampInt(source.short, LIMITS.short[0], LIMITS.short[1], base.short),
        long: clampInt(source.long, LIMITS.long[0], LIMITS.long[1], base.long),
        rounds: clampInt(source.rounds, LIMITS.rounds[0], LIMITS.rounds[1], base.rounds),
        autoStart: typeof source.autoStart === 'boolean' ? source.autoStart : base.autoStart,
        sound: typeof source.sound === 'boolean' ? source.sound : base.sound,
        float: typeof source.float === 'boolean' ? source.float : base.float,
        dock: typeof source.dock === 'boolean' ? source.dock : base.dock,
      }
    }

    /** `m:ss`, never negative; minutes stay unpadded like the host counters. */
    function formatTime(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000))
      const seconds = total % 60
      return `${Math.floor(total / 60)}:${String(seconds).padStart(2, '0')}`
    }

    /**
     * One module-level store shared by every surface and the notification path.
     * A countdown is derived from `endsAt`, so throttled timers and tab reloads
     * cannot drift it: only the phase transition is a decision.
     */
    let settings = defaultSettings()
    let phase = 'focus'
    let running = false
    let endsAt = 0
    let remainingMs = settings.focus * 60000
    let phaseTotalMs = remainingMs
    let doneFocus = 0
    let snapshot = null
    const subscribers = new Set()
    let tickerHandle = null
    let wakeHandle = null
    let lastSecond = -1
    let audio = null

    /** Translate keys through the host locale service; English otherwise. */
    let translate = (key) => (Object.prototype.hasOwnProperty.call(EN, key) ? EN[key] : key)

    /** Floating-window geometry: offsets from the bottom-right corner, in CSS px. */
    const DEFAULT_WINDOW_STATE = { right: 16, bottom: 16, collapsed: true }
    /** Released within this many pixels of an edge, the window sticks to it. */
    const SNAP_EDGE = 40
    /** Margin kept between a snapped window and the frame edge. */
    const SNAP_MARGIN = 12
    /** A click waits this long for a second click before expanding the chip. */
    const CHIP_CLICK_DELAY = 300
    /** The freshly expanded card ignores pointers this long, so a slow
     *  double-click cannot land on a control the chip used to cover. */
    const EXPAND_GUARD_MS = 340

    function readWindowState() {
      try {
        const raw = window.localStorage.getItem(WINDOW_KEY)
        if (raw === null) return { ...DEFAULT_WINDOW_STATE }
        const saved = JSON.parse(raw)
        if (saved === null || typeof saved !== 'object') return { ...DEFAULT_WINDOW_STATE }
        const right = Number(saved.right)
        const bottom = Number(saved.bottom)
        return {
          right: Number.isFinite(right) ? Math.max(4, right) : DEFAULT_WINDOW_STATE.right,
          bottom: Number.isFinite(bottom) ? Math.max(4, bottom) : DEFAULT_WINDOW_STATE.bottom,
          collapsed: typeof saved.collapsed === 'boolean' ? saved.collapsed : DEFAULT_WINDOW_STATE.collapsed,
        }
      } catch (error) {
        return { ...DEFAULT_WINDOW_STATE }
      }
    }

    function writeWindowState(state) {
      try {
        window.localStorage.setItem(WINDOW_KEY, JSON.stringify({
          right: Math.round(state.right),
          bottom: Math.round(state.bottom),
          collapsed: state.collapsed === true,
        }))
      } catch (error) {
        /* position is a nicety; keep rendering even when storage is closed */
      }
    }

    /** Next phase after `finished`, counting the focus phase just completed. */
    function nextPhaseAfter(finished) {
      if (finished !== 'focus') return 'focus'
      if (doneFocus > 0 && doneFocus % settings.rounds === 0) return 'long'
      return 'short'
    }

    function phaseLengthMs(name) {
      return settings[name] * 60000
    }

    /** Park the timer at the start of `next`, running or paused. */
    function enterPhase(next, shouldRun) {
      phase = next
      phaseTotalMs = phaseLengthMs(next)
      remainingMs = phaseTotalMs
      running = shouldRun === true
      endsAt = running ? Date.now() + remainingMs : 0
      lastSecond = -1
    }

    function buildSnapshot() {
      const left = running ? Math.max(0, endsAt - Date.now()) : Math.max(0, remainingMs)
      const total = Math.max(1000, phaseTotalMs)
      return {
        phase,
        running,
        remainingMs: left,
        totalMs: total,
        progress: Math.min(1, Math.max(0, 1 - left / total)),
        doneFocus,
        roundInCycle: phase === 'long' ? settings.rounds : doneFocus % settings.rounds,
        settings,
      }
    }

    /** Publish one immutable snapshot; listeners are React store callbacks. */
    function publish() {
      snapshot = buildSnapshot()
      for (const listener of Array.from(subscribers)) {
        try {
          listener()
        } catch (error) {
          /* one broken listener must not stop the others */
        }
      }
    }

    function persist() {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
          settings,
          phase,
          running,
          endsAt,
          remainingMs,
          doneFocus,
        }))
      } catch (error) {
        /* storage unavailable: the session still runs, it just will not resume */
      }
    }

    function ensureAudio() {
      try {
        if (audio === null) {
          const Ctor = window.AudioContext || window.webkitAudioContext
          if (typeof Ctor !== 'function') return
          audio = new Ctor()
        }
        if (audio.state === 'suspended') {
          const resumed = audio.resume()
          if (resumed !== undefined && typeof resumed.catch === 'function') resumed.catch(() => {})
        }
      } catch (error) {
        audio = null
      }
    }

    function disposeAudio() {
      if (audio === null) return
      const current = audio
      audio = null
      try {
        const closing = current.close()
        if (closing !== undefined && typeof closing.catch === 'function') closing.catch(() => {})
      } catch (error) {
        /* already closed */
      }
    }

    /** Two soft notes closing one phase; rising into a break, falling back. */
    function chime(rising) {
      if (settings.sound !== true) return
      ensureAudio()
      if (audio === null) return
      try {
        const start = audio.currentTime + 0.02
        const notes = rising === true ? [659.25, 880] : [880, 659.25]
        notes.forEach((frequency, index) => {
          const at = start + index * 0.19
          const oscillator = audio.createOscillator()
          const gain = audio.createGain()
          oscillator.type = 'sine'
          oscillator.frequency.setValueAtTime(frequency, at)
          gain.gain.setValueAtTime(0.0001, at)
          gain.gain.exponentialRampToValueAtTime(0.09, at + 0.03)
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.42)
          oscillator.connect(gain)
          gain.connect(audio.destination)
          oscillator.start(at)
          oscillator.stop(at + 0.45)
        })
      } catch (error) {
        /* silence is an acceptable fallback */
      }
    }

    function notifyPhase(finished) {
      try {
        if (typeof window.Notification !== 'function') return
        if (window.Notification.permission !== 'granted') return
        const body = translate(finished === 'focus' ? 'focusDone' : 'breakDone')
        new window.Notification(translate('pluginName'), { body, tag: 'dsh-pomodoro', silent: true })
      } catch (error) {
        /* notifications are best-effort */
      }
    }

    /** Ask once, from the click that starts the timer (a user gesture). */
    function requestNotifications() {
      try {
        if (typeof window.Notification !== 'function') return
        if (window.Notification.permission !== 'default') return
        const pending = window.Notification.requestPermission()
        if (pending !== undefined && typeof pending.then === 'function') {
          pending.then(() => {}, () => {})
        }
      } catch (error) {
        /* unsupported browser */
      }
    }

    /** Advance exactly one phase; skipping keeps the current run state. */
    function finishPhase(skipped) {
      const finished = phase
      const wasRunning = running
      if (finished === 'focus' && skipped !== true) doneFocus += 1
      const next = nextPhaseAfter(finished)
      const shouldRun = skipped === true ? wasRunning : settings.autoStart
      enterPhase(next, shouldRun)
      persist()
      publish()
      if (skipped !== true) {
        chime(finished === 'focus')
        notifyPhase(finished)
      }
      armWake()
    }

    function tick() {
      if (running !== true) return
      const left = endsAt - Date.now()
      if (left > 0) {
        const second = Math.ceil(left / 1000)
        if (second !== lastSecond) {
          lastSecond = second
          publish()
        }
        return
      }
      finishPhase(false)
    }

    function startTicker() {
      if (tickerHandle !== null) return
      tickerHandle = setInterval(tick, TICK_MS)
    }

    function stopTicker() {
      if (tickerHandle !== null) {
        clearInterval(tickerHandle)
        tickerHandle = null
      }
      if (wakeHandle !== null) {
        clearTimeout(wakeHandle)
        wakeHandle = null
      }
    }

    /** Fire at the exact completion instant even while the page is hidden. */
    function armWake() {
      if (wakeHandle !== null) {
        clearTimeout(wakeHandle)
        wakeHandle = null
      }
      if (running !== true) return
      const delay = Math.max(0, endsAt - Date.now())
      wakeHandle = setTimeout(() => {
        wakeHandle = null
        tick()
      }, Math.min(delay + 40, MAX_TIMEOUT))
    }

    function startTimer() {
      if (running === true) return
      const full = phaseLengthMs(phase)
      if (remainingMs <= 0 || remainingMs > full) {
        remainingMs = full
        phaseTotalMs = full
      }
      endsAt = Date.now() + remainingMs
      running = true
      lastSecond = -1
      ensureAudio()
      requestNotifications()
      persist()
      publish()
      armWake()
    }

    function pauseTimer() {
      if (running !== true) return
      remainingMs = Math.max(0, endsAt - Date.now())
      running = false
      endsAt = 0
      persist()
      publish()
      armWake()
    }

    function toggleTimer() {
      if (running === true) pauseTimer()
      else startTimer()
    }

    function resetPhase() {
      running = false
      endsAt = 0
      phaseTotalMs = phaseLengthMs(phase)
      remainingMs = phaseTotalMs
      lastSecond = -1
      persist()
      publish()
      armWake()
    }

    function skipPhase() {
      finishPhase(true)
    }

    /** Preferences apply to the parked phase immediately; a running one keeps
     * its current length so the progress ring never jumps mid-phase. */
    function updateSettings(patch) {
      settings = normalizeSettings({ ...settings, ...patch })
      if (running !== true) {
        phaseTotalMs = phaseLengthMs(phase)
        remainingMs = phaseTotalMs
        lastSecond = -1
      }
      persist()
      publish()
    }

    function restoreDefaults() {
      settings = defaultSettings()
      if (running !== true) {
        phaseTotalMs = phaseLengthMs(phase)
        remainingMs = phaseTotalMs
        lastSecond = -1
      }
      persist()
      publish()
    }

    /** Restore the last countdown, settling at most one phase boundary. */
    function hydrate() {
      let saved = null
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        saved = raw === null ? null : JSON.parse(raw)
      } catch (error) {
        saved = null
      }
      if (saved === null || typeof saved !== 'object') return
      settings = normalizeSettings(saved.settings)
      phase = PHASES.indexOf(saved.phase) === -1 ? 'focus' : saved.phase
      phaseTotalMs = phaseLengthMs(phase)
      remainingMs = phaseTotalMs
      doneFocus = clampInt(saved.doneFocus, 0, 100000, 0)
      const savedEnd = Number(saved.endsAt)
      const savedLeft = Number(saved.remainingMs)
      if (saved.running === true && Number.isFinite(savedEnd) && savedEnd > Date.now()) {
        running = true
        endsAt = savedEnd
        phaseTotalMs = Math.max(phaseTotalMs, endsAt - Date.now())
        return
      }
      if (saved.running === true && Number.isFinite(savedEnd)) {
        if (phase === 'focus') doneFocus += 1
        phase = nextPhaseAfter(phase)
        enterPhase(phase, false)
        persist()
        return
      }
      running = false
      endsAt = 0
      if (Number.isFinite(savedLeft) && savedLeft > 0) {
        remainingMs = Math.min(savedLeft, phaseTotalMs)
      }
    }

    /** Observable source consumed through the slot `hooks` seat. */
    const pomodoroSource = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        subscribers.add(listener)
        return () => {
          subscribers.delete(listener)
        }
      },
    }

    /** Component-local stylesheet; unmounting the entry removes it. */
    const CSS = [
      '.dsp-root{display:inline-flex;flex-direction:column;align-items:flex-end;gap:6px;',
      'font-size:12px;line-height:20px;--dsp-accent:var(--dsw-alias-label-tertiary)}',
      '.dsp-root[data-phase="focus"],.dspf-root[data-phase="focus"]{',
      '--dsp-accent:var(--dsw-alias-state-error-primary)}',
      '.dsp-root[data-phase="short"],.dsp-root[data-phase="long"],',
      '.dspf-root[data-phase="short"],.dspf-root[data-phase="long"]{',
      '--dsp-accent:var(--dsw-alias-state-success-primary)}',
      '.dsp-bar{display:inline-flex;align-items:center;gap:1px;white-space:nowrap}',
      '.dsp-clock{display:inline-flex;align-items:center;gap:6px;height:22px;',
      'padding:0 6px 0 5px;border:none;border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-secondary);font:inherit;font-variant-numeric:tabular-nums;',
      'letter-spacing:.01em;cursor:pointer}',
      '.dsp-clock:hover{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-primary)}',
      '.dsp-ring{flex:none;display:block;color:var(--dsp-accent)}',
      '.dsp-time{font-weight:500}',
      '.dsp-root[data-running="true"] .dsp-time{color:var(--dsw-alias-label-primary)}',
      '.dsp-phase{color:var(--dsw-alias-label-tertiary);font-size:11px;padding:0 2px}',
      '.dspf-dots{display:inline-flex;align-items:center;gap:2px;margin:0 3px}',
      '.dsp-dot,.dspf-dot{width:4px;height:4px;border-radius:50%;',
      'background:var(--dsw-alias-border-l2)}',
      '.dsp-dot[data-filled="true"],.dspf-dot[data-filled="true"]{background:var(--dsp-accent)}',
      '.dsp-icon{display:grid;place-items:center;width:22px;height:22px;padding:0;',
      'border:none;border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.dsp-icon:hover,.dsp-icon[aria-expanded="true"]{',
      'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsp-panel{box-sizing:border-box;width:252px;display:flex;flex-direction:column;gap:7px;',
      'padding:10px 10px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;',
      'background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-panel);',
      'color:var(--dsw-alias-label-primary)}',
      '.dsp-row{display:flex;align-items:center;justify-content:space-between;gap:10px;',
      'min-height:24px}',
      '.dsp-row-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsp-field{display:inline-flex;align-items:center;gap:5px}',
      '.dsp-num{box-sizing:border-box;width:50px;height:25px;padding:0 4px;',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:6px;',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);',
      'font:inherit;font-size:12px;text-align:center;font-variant-numeric:tabular-nums;',
      'appearance:textfield}',
      '.dsp-num::-webkit-outer-spin-button,.dsp-num::-webkit-inner-spin-button{',
      '-webkit-appearance:none;margin:0}',
      '.dsp-unit{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dsp-switch{position:relative;flex:none;width:30px;height:17px;padding:0;',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:999px;',
      'background:var(--dsw-alias-bg-layer-2);cursor:pointer;',
      'transition:background-color .15s ease,border-color .15s ease}',
      '.dsp-switch::after{content:"";position:absolute;top:1px;left:1px;width:13px;height:13px;',
      'border-radius:50%;background:var(--dsw-alias-label-tertiary);',
      'transition:transform .15s ease,background-color .15s ease}',
      '.dsp-switch[aria-checked="true"]{border-color:var(--dsw-alias-brand-primary);',
      'background:var(--dsw-alias-brand-primary)}',
      '.dsp-switch[aria-checked="true"]::after{transform:translateX(13px);',
      'background:var(--dsw-alias-bg-base)}',
      '.dsp-rule{height:1px;background:var(--dsw-alias-border-l1);margin:1px 0}',
      '.dsp-actions{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dsp-action{height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);',
      'font:inherit;font-size:11px;cursor:pointer}',
      '.dsp-action:hover{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-primary)}',
      '.dsp-root button:focus-visible,.dsp-root input:focus-visible,.dspf-root button:focus-visible,',
      '.dspf-root input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '@media (prefers-reduced-motion:reduce){.dsp-switch,.dsp-switch::after,',
      '.dspf-root{transition:none}}',
      // Floating window: frame-wide, pointer-active only on its own box.
      '.dspf-root{position:fixed;z-index:5;display:flex;flex-direction:column;',
      'align-items:flex-end;gap:8px;pointer-events:auto;font-size:12px;line-height:18px;',
      'font-family:inherit;transition:right .16s ease,bottom .16s ease}',
      '.dspf-root[data-dragging="true"]{transition:none}',
      '.dspf-chip{display:inline-flex;align-items:center;gap:7px;height:32px;',
      'padding:0 12px 0 8px;border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:999px;background:var(--dsw-alias-bg-overlay);',
      'box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-secondary);',
      'font:inherit;font-variant-numeric:tabular-nums;cursor:pointer;',
      'user-select:none;touch-action:none;',
      'transition:transform .12s ease,color .12s ease}',
      '.dspf-chip:hover{transform:translateY(-1px);color:var(--dsw-alias-label-primary)}',
      '.dspf-chip:active{transform:translateY(0)}',
      '.dspf-chip-time{font-weight:500}',
      '.dspf-card{box-sizing:border-box;width:246px;display:flex;flex-direction:column;gap:8px;',
      'padding:9px 12px 12px;border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:14px;background:var(--dsw-alias-bg-overlay);',
      'box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary)}',
      '.dspf-head{display:flex;align-items:center;gap:6px;margin:-1px -4px 0 -4px;',
      'padding:1px 4px;cursor:grab;user-select:none;touch-action:none}',
      '.dspf-head:active{cursor:grabbing}',
      '.dspf-grip{display:grid;place-items:center;width:16px;height:16px;',
      'color:var(--dsw-alias-label-tertiary)}',
      '.dspf-title{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px;',
      'letter-spacing:.02em}',
      '.dspf-min{display:grid;place-items:center;width:20px;height:20px;padding:0;',
      'border:none;border-radius:5px;background:transparent;',
      'color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.dspf-min:hover{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-primary)}',
      '.dspf-body{display:flex;flex-direction:column;align-items:center;gap:3px;',
      'user-select:none}',
      '.dspf-clock{position:relative;display:grid;place-items:center;width:64px;height:64px}',
      '.dspf-time{position:absolute;inset:0;display:grid;place-items:center;font-size:13px;',
      'font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.dspf-meta{display:flex;align-items:center;gap:7px;font-size:11px}',
      '.dspf-phase{color:var(--dsw-alias-label-secondary)}',
      '.dspf-controls{display:flex;align-items:center;gap:6px;margin-top:2px}',
      '.dspf-primary{flex:1;height:30px;border:none;border-radius:8px;',
      'background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);',
      'font:inherit;font-size:12px;font-weight:500;cursor:pointer}',
      '.dspf-primary:hover{opacity:.88}',
      '.dspf-tool{display:grid;place-items:center;width:30px;height:30px;padding:0;',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;',
      'color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.dspf-tool:hover,.dspf-tool[aria-expanded="true"]{',
      'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dspf-settings{border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}',
      '.dspf-settings .dsp-panel{width:100%;padding:0;border:none;background:transparent;',
      'box-shadow:none;gap:6px}',
    ].join('')

    function Ring(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      const large = size >= 40
      const radius = large ? 6.6 : 6.2
      const stroke = large ? 1.05 : 1.8
      const circumference = 2 * Math.PI * radius
      const offset = circumference * (1 - props.progress)
      return h('svg', {
        className: 'dsp-ring', viewBox: '0 0 16 16', width: size, height: size,
        'aria-hidden': true, focusable: 'false',
      },
        h('circle', {
          cx: 8, cy: 8, r: radius, fill: 'none', stroke: 'currentColor',
          strokeOpacity: 0.18, strokeWidth: stroke,
        }),
        h('circle', {
          cx: 8, cy: 8, r: radius, fill: 'none', stroke: 'currentColor',
          strokeWidth: stroke, strokeLinecap: 'round',
          strokeDasharray: circumference, strokeDashoffset: offset,
          transform: 'rotate(-90 8 8)',
        }),
      )
    }

    function SkipIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true, focusable: 'false',
      },
        h('path', { d: 'M3.4 2.7v10.6l7.3-5.3-7.3-5.3Z', fill: 'currentColor' }),
        h('rect', { x: 11.3, y: 2.7, width: 1.7, height: 10.6, rx: 0.85, fill: 'currentColor' }),
      )
    }

    function ResetIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': true, focusable: 'false',
        fill: 'none', stroke: 'currentColor', strokeWidth: 2,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('path', { d: 'M3.51 15a9 9 0 1 0 2.13-9.36L1 10' }),
        h('path', { d: 'M1 4v6h6' }),
      )
    }

    function GearIcon() {
      const teeth = [0, 45, 90, 135].map((angle) => h('line', {
        key: `tooth-${angle}`,
        x1: 8, y1: 1.4, x2: 8, y2: 3.3,
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
        transform: `rotate(${angle} 8 8)`,
      }))
      return h('svg', {
        viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true, focusable: 'false',
      },
        h('circle', {
          cx: 8, cy: 8, r: 4.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
        }),
        h('circle', { cx: 8, cy: 8, r: 1.5, fill: 'currentColor' }),
        teeth,
      )
    }

    function GripIcon() {
      const dots = []
      for (const y of [3.5, 8, 12.5]) {
        for (const x of [6, 10]) {
          dots.push(h('circle', { key: `grip-${x}-${y}`, cx: x, cy: y, r: 1.15, fill: 'currentColor' }))
        }
      }
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: 'false',
      }, dots)
    }

    function CollapseIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true, focusable: 'false',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }, h('path', { d: 'M4 6.5 8 10.5 12 6.5' }))
    }

    /** A number field commits on blur or Enter, so typing never fights it. */
    function NumberRow(props) {
      const [draft, setDraft] = React.useState(String(props.value))
      React.useEffect(() => {
        setDraft(String(props.value))
      }, [props.value])
      const commit = () => {
        const parsed = Number(draft)
        if (draft.trim() === '' || !Number.isFinite(parsed)) {
          setDraft(String(props.value))
          return
        }
        const next = Math.min(props.max, Math.max(props.min, Math.round(parsed)))
        setDraft(String(next))
        if (next !== props.value) props.onChange(next)
      }
      return h('label', { className: 'dsp-row' },
        h('span', { className: 'dsp-row-label' }, props.label),
        h('span', { className: 'dsp-field' },
          h('input', {
            className: 'dsp-num',
            type: 'number',
            inputMode: 'numeric',
            min: props.min,
            max: props.max,
            step: 1,
            value: draft,
            'aria-label': props.label,
            onChange: (event) => setDraft(event.target.value),
            onBlur: commit,
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              commit()
              event.currentTarget.blur()
            },
          }),
          h('span', { className: 'dsp-unit' }, props.unit),
        ),
      )
    }

    function SwitchRow(props) {
      return h('div', { className: 'dsp-row' },
        h('span', { className: 'dsp-row-label' }, props.label),
        h('button', {
          type: 'button',
          className: 'dsp-switch',
          role: 'switch',
          'aria-checked': props.checked === true,
          'aria-label': props.label,
          onClick: () => props.onChange(props.checked !== true),
        }),
      )
    }

    function SettingsPanel(props) {
      const settingsNow = props.settings
      /** Keep at least one surface visible: hiding one reveals the other. */
      const changeDock = (value) => {
        if (value === false && settingsNow.float !== true) props.onSettings({ dock: false, float: true })
        else props.onSettings({ dock: value })
      }
      const changeFloat = (value) => {
        if (value === false && settingsNow.dock !== true) props.onSettings({ float: false, dock: true })
        else props.onSettings({ float: value })
      }
      return h('div', {
        className: 'dsp-panel', role: 'group', 'aria-label': props.t('settings'),
      },
        h(NumberRow, {
          label: props.t('focusLength'), value: settingsNow.focus,
          min: LIMITS.focus[0], max: LIMITS.focus[1], unit: props.t('minutes'),
          onChange: (value) => props.onSettings({ focus: value }),
        }),
        h(NumberRow, {
          label: props.t('shortLength'), value: settingsNow.short,
          min: LIMITS.short[0], max: LIMITS.short[1], unit: props.t('minutes'),
          onChange: (value) => props.onSettings({ short: value }),
        }),
        h(NumberRow, {
          label: props.t('longLength'), value: settingsNow.long,
          min: LIMITS.long[0], max: LIMITS.long[1], unit: props.t('minutes'),
          onChange: (value) => props.onSettings({ long: value }),
        }),
        h(NumberRow, {
          label: props.t('rounds'), value: settingsNow.rounds,
          min: LIMITS.rounds[0], max: LIMITS.rounds[1], unit: props.t('roundsUnit'),
          onChange: (value) => props.onSettings({ rounds: value }),
        }),
        h('div', { className: 'dsp-rule', 'aria-hidden': true }),
        h(SwitchRow, {
          label: props.t('autoStart'), checked: settingsNow.autoStart,
          onChange: (value) => props.onSettings({ autoStart: value }),
        }),
        h(SwitchRow, {
          label: props.t('sound'), checked: settingsNow.sound,
          onChange: (value) => props.onSettings({ sound: value }),
        }),
        h('div', { className: 'dsp-rule', 'aria-hidden': true }),
        h(SwitchRow, {
          label: props.t('floatToggle'), checked: settingsNow.float,
          onChange: changeFloat,
        }),
        h(SwitchRow, {
          label: props.t('dockToggle'), checked: settingsNow.dock,
          onChange: changeDock,
        }),
        h('div', { className: 'dsp-actions' },
          h('button', {
            type: 'button', className: 'dsp-action', onClick: props.onResetPhase,
          }, props.t('resetPhase')),
          h('button', {
            type: 'button', className: 'dsp-action', onClick: props.onRestoreDefaults,
          }, props.t('restoreDefaults')),
        ),
      )
    }

    /** Dot row shared by both surfaces: completed focus phases in this cycle. */
    function CycleDots(props) {
      const dots = []
      for (let index = 0; index < props.rounds; index += 1) {
        dots.push(h('span', {
          key: `dot-${index}`,
          className: props.className,
          'data-filled': index < props.filled,
        }))
      }
      return h('span', { className: 'dspf-dots', 'aria-hidden': true }, dots)
    }

    /** Ambient composer-dock pill; hidden when the preference is off. */
    function PomodoroPill(props) {
      const t = typeof props.t === 'function'
        ? props.t
        : (key) => (Object.prototype.hasOwnProperty.call(EN, key) ? EN[key] : key)
      const state = props.usePomodoro((value) => value)
      const [panelOpen, setPanelOpen] = React.useState(false)
      const rootRef = React.useRef(null)

      React.useEffect(() => {
        if (panelOpen !== true) return undefined
        const onPointerDown = (event) => {
          const root = rootRef.current
          if (root !== null && !root.contains(event.target)) setPanelOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setPanelOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [panelOpen])

      if (state.settings.dock !== true) return null

      const time = formatTime(state.remainingMs)
      const actionLabel = t(state.running === true ? 'pause' : 'start')

      return h('div', {
        ref: rootRef,
        className: 'dsp-root',
        'data-phase': state.phase,
        'data-running': state.running === true,
      },
        h('style', { key: 'dsp-style' }, CSS),
        h('div', { className: 'dsp-bar' },
          h('button', {
            type: 'button',
            className: 'dsp-clock',
            title: t(state.running === true ? 'pauseHint' : 'startHint'),
            'aria-label': `${actionLabel} · ${time}`,
            onClick: toggleTimer,
          },
            h(Ring, { progress: state.progress }),
            h('span', { className: 'dsp-time' }, time),
          ),
          h('span', { className: 'dsp-phase', title: t(state.phase) }, t(state.phase)),
          h(CycleDots, {
            rounds: state.settings.rounds, filled: state.roundInCycle, className: 'dsp-dot',
          }),
          h('button', {
            type: 'button',
            className: 'dsp-icon',
            title: t('skip'),
            'aria-label': t('skip'),
            onClick: skipPhase,
          }, h(SkipIcon)),
          h('button', {
            type: 'button',
            className: 'dsp-icon',
            title: t('settings'),
            'aria-label': t('settings'),
            'aria-expanded': panelOpen,
            onClick: () => setPanelOpen((open) => !open),
          }, h(GearIcon)),
        ),
        panelOpen === true ? h(SettingsPanel, {
          t,
          settings: state.settings,
          onSettings: updateSettings,
          onResetPhase: resetPhase,
          onRestoreDefaults: restoreDefaults,
        }) : null,
      )
    }

    /**
     * Frame-wide floating timer. Collapsed it is a chip showing the countdown;
     * expanded it is a draggable card with the ring, controls and preferences.
     * Offsets from the bottom-right corner persist, and every size change
     * re-clamps the surface into the viewport.
     */
    function FloatingPomodoro(props) {
      const t = typeof props.t === 'function'
        ? props.t
        : (key) => (Object.prototype.hasOwnProperty.call(EN, key) ? EN[key] : key)
      const state = props.usePomodoro((value) => value)
      const [layout, setLayout] = React.useState(readWindowState)
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [dragging, setDragging] = React.useState(false)
      const rootRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const layoutRef = React.useRef(layout)
      const clickTimerRef = React.useRef(null)
      const guardTimerRef = React.useRef(null)
      const suppressClickRef = React.useRef(false)
      const [guarded, setGuarded] = React.useState(false)
      const collapsed = layout.collapsed === true

      const applyLayout = (next, persist) => {
        layoutRef.current = next
        setLayout(next)
        if (persist === true) writeWindowState(next)
      }

      const cancelChipClick = () => {
        if (clickTimerRef.current === null) return
        clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
      }

      /** Expand the chip into the card and hold its controls briefly. */
      const expandFromChip = () => {
        cancelChipClick()
        applyLayout({ ...layoutRef.current, collapsed: false }, true)
        if (guardTimerRef.current !== null) clearTimeout(guardTimerRef.current)
        setGuarded(true)
        guardTimerRef.current = setTimeout(() => {
          guardTimerRef.current = null
          setGuarded(false)
        }, EXPAND_GUARD_MS)
      }

      React.useEffect(() => {
        const clampIntoView = () => {
          const element = rootRef.current
          if (element === null) return
          const rect = element.getBoundingClientRect()
          const maxRight = Math.max(4, window.innerWidth - rect.width - 4)
          const maxBottom = Math.max(4, window.innerHeight - rect.height - 4)
          const current = layoutRef.current
          const right = Math.min(current.right, maxRight)
          const bottom = Math.min(current.bottom, maxBottom)
          if (right === current.right && bottom === current.bottom) return
          applyLayout({ ...current, right, bottom }, true)
        }
        clampIntoView()
        window.addEventListener('resize', clampIntoView)
        return () => window.removeEventListener('resize', clampIntoView)
      }, [collapsed, settingsOpen, state.settings.float])

      React.useEffect(() => {
        if (settingsOpen !== true) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setSettingsOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [settingsOpen])

      React.useEffect(() => () => {
        cancelChipClick()
        if (guardTimerRef.current !== null) clearTimeout(guardTimerRef.current)
      }, [])

      if (state.settings.float !== true) return null

      const time = formatTime(state.remainingMs)
      const phaseLabel = t(state.phase)
      const actionLabel = t(state.running === true ? 'pause' : 'start')

      /** Begin a drag from the card header or from the collapsed chip. */
      const startGesture = (event, fromChip) => {
        if (event.button !== 0) return
        if (fromChip !== true) {
          const target = event.target
          if (target !== null && typeof target.closest === 'function' && target.closest('button') !== null) return
        }
        const element = rootRef.current
        if (element === null) return
        const rect = element.getBoundingClientRect()
        suppressClickRef.current = false
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          right: window.innerWidth - rect.right,
          bottom: window.innerHeight - rect.bottom,
          maxRight: Math.max(4, window.innerWidth - rect.width - 4),
          maxBottom: Math.max(4, window.innerHeight - rect.height - 4),
          chip: fromChip === true,
          moved: false,
        }
        setDragging(true)
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch (error) {
          /* capture is a nicety; without it a fast drag can outrun the pointer */
        }
      }

      const moveDrag = (event) => {
        const drag = dragRef.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        if (drag.moved !== true && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
        drag.moved = true
        applyLayout({
          ...layoutRef.current,
          right: Math.min(drag.maxRight, Math.max(4, drag.right - dx)),
          bottom: Math.min(drag.maxBottom, Math.max(4, drag.bottom - dy)),
        }, false)
      }

      /** Magnet: a release near an edge puts the window flush except a margin. */
      const snapToEdge = (current) => {
        const element = rootRef.current
        if (element === null) return current
        const rect = element.getBoundingClientRect()
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight
        const left = viewportWidth - current.right - rect.width
        const top = viewportHeight - current.bottom - rect.height
        let right = current.right
        let bottom = current.bottom
        if (left <= SNAP_EDGE) right = viewportWidth - rect.width - SNAP_MARGIN
        else if (current.right <= SNAP_EDGE) right = SNAP_MARGIN
        if (top <= SNAP_EDGE) bottom = viewportHeight - rect.height - SNAP_MARGIN
        else if (current.bottom <= SNAP_EDGE) bottom = SNAP_MARGIN
        return {
          ...current,
          right: Math.max(4, Math.round(right)),
          bottom: Math.max(4, Math.round(bottom)),
        }
      }

      const endDrag = (event) => {
        const drag = dragRef.current
        if (drag === null) return
        dragRef.current = null
        setDragging(false)
        try {
          event.currentTarget.releasePointerCapture(drag.pointerId)
        } catch (error) {
          /* already released */
        }
        if (drag.moved === true && drag.chip === true) suppressClickRef.current = true
        applyLayout(snapToEdge(layoutRef.current), true)
      }

      /** One click expands; the delayed action gives a double-click its chance. */
      const handleChipClick = () => {
        if (suppressClickRef.current === true) {
          suppressClickRef.current = false
          return
        }
        cancelChipClick()
        clickTimerRef.current = setTimeout(() => {
          clickTimerRef.current = null
          expandFromChip()
        }, CHIP_CLICK_DELAY)
      }

      const handleChipDoubleClick = (event) => {
        event.preventDefault()
        cancelChipClick()
        suppressClickRef.current = false
        toggleTimer()
      }

      const handleDoubleClick = (event) => {
        event.preventDefault()
        toggleTimer()
      }

      /** Keyboard activation has no double-click, so Enter/Space expands at once. */
      const handleChipKeyDown = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
        event.preventDefault()
        expandFromChip()
      }

      return h('div', {
        ref: rootRef,
        className: 'dspf-root',
        style: { right: `${Math.round(layout.right)}px`, bottom: `${Math.round(layout.bottom)}px` },
        'data-phase': state.phase,
        'data-running': state.running === true,
        'data-dragging': dragging === true,
      },
        h('style', { key: 'dsp-style' }, CSS),
        collapsed === true
          ? h('button', {
            type: 'button',
            className: 'dspf-chip',
            title: t('chipHint'),
            'aria-label': `${t('pluginName')} · ${phaseLabel} ${time} · ${t('chipHint')}`,
            onClick: handleChipClick,
            onDoubleClick: handleChipDoubleClick,
            onKeyDown: handleChipKeyDown,
            onPointerDown: (event) => startGesture(event, true),
            onPointerMove: moveDrag,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
          },
            h(Ring, { progress: state.progress, size: 17 }),
            h('span', { className: 'dspf-chip-time' }, time),
          )
          : h('div', {
            className: 'dspf-card',
            role: 'group',
            'aria-label': t('pluginName'),
            'data-guarded': guarded === true,
            onPointerDownCapture: (event) => {
              if (guarded !== true) return
              event.preventDefault()
              event.stopPropagation()
            },
            onClickCapture: (event) => {
              if (guarded !== true) return
              event.preventDefault()
              event.stopPropagation()
            },
          },
            h('div', {
              className: 'dspf-head',
              onPointerDown: (event) => startGesture(event, false),
              onPointerMove: moveDrag,
              onPointerUp: endDrag,
              onPointerCancel: endDrag,
            },
              h('span', { className: 'dspf-grip' }, h(GripIcon)),
              h('span', { className: 'dspf-title' }, t('pluginName')),
              h('button', {
                type: 'button',
                className: 'dspf-min',
                title: t('collapse'),
                'aria-label': t('collapse'),
                onClick: () => applyLayout({ ...layoutRef.current, collapsed: true }, true),
              }, h(CollapseIcon)),
            ),
            h('div', {
              className: 'dspf-body',
              title: t('doubleClickHint'),
              onDoubleClick: handleDoubleClick,
            },
              h('div', { className: 'dspf-clock' },
                h(Ring, { progress: state.progress, size: 64 }),
                h('span', { className: 'dspf-time' }, time),
              ),
              h('div', { className: 'dspf-meta' },
                h('span', { className: 'dspf-phase' }, phaseLabel),
                h(CycleDots, {
                  rounds: state.settings.rounds, filled: state.roundInCycle, className: 'dspf-dot',
                }),
              ),
            ),
            h('div', { className: 'dspf-controls' },
              h('button', {
                type: 'button',
                className: 'dspf-primary',
                onClick: toggleTimer,
              }, actionLabel),
              h('button', {
                type: 'button', className: 'dspf-tool',
                title: t('skip'), 'aria-label': t('skip'),
                onClick: skipPhase,
              }, h(SkipIcon)),
              h('button', {
                type: 'button', className: 'dspf-tool',
                title: t('resetPhase'), 'aria-label': t('resetPhase'),
                onClick: resetPhase,
              }, h(ResetIcon)),
              h('button', {
                type: 'button', className: 'dspf-tool',
                title: t('settings'), 'aria-label': t('settings'),
                'aria-expanded': settingsOpen,
                onClick: () => setSettingsOpen((open) => !open),
              }, h(GearIcon)),
            ),
            settingsOpen === true ? h('div', { className: 'dspf-settings' },
              h(SettingsPanel, {
                t,
                settings: state.settings,
                onSettings: updateSettings,
                onResetPhase: resetPhase,
                onRestoreDefaults: restoreDefaults,
              }),
            ) : null,
          ),
      )
    }

    /** Register the dictionaries and adopt the bound translator. */
    function bindDictionary(ctx) {
      const locale = ctx.get('locale')
      if (locale === undefined || locale === null) return
      try {
        const bound = locale.bind(NS)
        translate = (key) => bound(key)
      } catch (error) {
        /* the English fallback stays */
      }
      for (const pair of [['en', EN], ['zh', ZH]]) {
        ctx.effect(() => {
          try {
            return locale.register(NS, pair[0], pair[1])
          } catch (error) {
            return () => {}
          }
        })
      }
    }

    /** Own the ticker and the audio context for exactly the plugin lifetime. */
    function activatePlugin() {
      startTicker()
      armWake()
      return () => {
        stopTicker()
        disposeAudio()
      }
    }

    hydrate()
    snapshot = buildSnapshot()

    return {
      inject: ['slots'],
      apply(ctx) {
        bindDictionary(ctx)
        ctx.effect(activatePlugin)
        const locale = ctx.get('locale')
        const hasLocale = locale !== undefined && locale !== null
        const slotOptions = (name, id, order) => ({
          name,
          id,
          order,
          ...(hasLocale ? { locale: NS } : {}),
          inject: () => ({ hooks: { pomodoro: pomodoroSource } }),
        })
        // Frame-wide: visible with or without an open session.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          slotOptions('shell.overlay', 'pomodoro-window', 40),
          FloatingPomodoro,
        ))
        // Ambient, session-scoped: an extra seat the preference can hide.
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          slotOptions('conversation.composer.dock', 'pomodoro', 3),
          PomodoroPill,
        ))
      },
    }
  },
})
