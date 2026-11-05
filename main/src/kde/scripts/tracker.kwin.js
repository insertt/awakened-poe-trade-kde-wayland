// KWin script (Plasma 6 scripting API). Runs INSIDE the compositor, not in Node.
// The config placeholder below is replaced with a JSON object:
//   { gameTitle, overlayTitle, overlayPid, service, path, iface }
// Events to Node (callDBus -> Tracker.Event(type, json)):
//   ready, attach, detach, moveresize, fullscreen, active, cursor, ack
// Commands from Node (long-poll of Tracker.NextCommand):
//   activate-overlay, focus-game, show-overlay, hide-overlay (+ optional seq -> ack)
(function () {
  var cfg = __CONFIG__
  var game = null
  var overlay = null
  var lastActive = null // 'game' | 'overlay' | 'other'
  // The overlay may only hold focus when Node asked for it. On Wayland, showing
  // a window activates it (there is no "show inactive"), which would take focus
  // from the game every time the overlay appears.
  var allowOverlayFocus = false

  function send (type, payload) {
    callDBus(cfg.service, cfg.path, cfg.iface, 'Event', type, JSON.stringify(payload || {}))
  }

  function rect (w) {
    var g = w.frameGeometry
    return { x: Math.round(g.x), y: Math.round(g.y), width: Math.round(g.width), height: Math.round(g.height) }
  }

  function isGame (w) { return String(w.caption).trim() === cfg.gameTitle }
  function isOverlay (w) { return w.pid === cfg.overlayPid && String(w.caption) === cfg.overlayTitle }

  function syncOverlay () {
    if (!overlay) return
    overlay.keepAbove = true
    overlay.skipTaskbar = true
    overlay.skipPager = true
    overlay.skipSwitcher = true
    overlay.noBorder = true
    if (game) {
      var r = game.frameGeometry
      if (overlay.frameGeometry.x !== r.x || overlay.frameGeometry.y !== r.y ||
          overlay.frameGeometry.width !== r.width || overlay.frameGeometry.height !== r.height) {
        overlay.frameGeometry = { x: r.x, y: r.y, width: r.width, height: r.height }
      }
    }
  }

  function reportActive () {
    var a = workspace.activeWindow
    var now = (a && game && a === game) ? 'game'
      : (a && overlay && a === overlay) ? 'overlay' : 'other'
    if (now === lastActive) return
    lastActive = now
    send('active', { target: now })
    if (now !== 'other') sendCursor()
  }

  function onActivated () {
    var a = workspace.activeWindow
    if (!a) {
      // KWin briefly has no active window while focus moves between windows;
      // reporting that as "other" makes Node hide the overlay mid-switch.
      if (game && game.minimized) reportActive()
      return
    }
    // Like electron-overlay-window on X11: the *focused* window with the game's
    // title is the game. Wine/Proton can create several windows with that title.
    if (a !== game && isGame(a)) {
      allowOverlayFocus = false
      attachGame(a) // also reports the active state
      return
    }
    if (overlay && a === overlay && !allowOverlayFocus && game) {
      // activated by being shown, not on request: hand focus straight back
      workspace.activeWindow = game
      return
    }
    if (a === game) allowOverlayFocus = false
    reportActive()
  }

  // Global pointer position. Only sent while the game/overlay is active, and
  // throttled: every pointer motion would otherwise be a D-Bus call.
  // (No timers in KWin JS scripts, so a trailing event can be dropped;
  // the next motion corrects it.)
  var CURSOR_INTERVAL_MS = 8
  var lastCursorAt = 0
  function sendCursor () {
    var p = workspace.cursorPos
    if (!p) return
    lastCursorAt = Date.now()
    send('cursor', { x: Math.round(p.x), y: Math.round(p.y) })
  }
  if (workspace.cursorPosChanged) {
    workspace.cursorPosChanged.connect(function () {
      if (lastActive !== 'game' && lastActive !== 'overlay') return
      if (Date.now() - lastCursorAt < CURSOR_INTERVAL_MS) return
      sendCursor()
    })
  }

  function watchGame (w) {
    w.frameGeometryChanged.connect(function () {
      if (w !== game) return
      send('moveresize', rect(w))
      syncOverlay()
    })
    w.fullScreenChanged.connect(function () {
      if (w === game) send('fullscreen', { isFullscreen: !!w.fullScreen })
    })
    w.captionChanged.connect(function () { consider(w) })
  }

  function countMatches () {
    return workspace.windowList().filter(isGame).length
  }

  function attachGame (w) {
    game = w
    send('attach', {
      geometry: rect(w),
      isFullscreen: !!w.fullScreen,
      pid: w.pid,
      resourceClass: String(w.resourceClass),
      matches: countMatches()
    })
    syncOverlay()
    reportActive()
  }

  function consider (w) {
    if (isOverlay(w)) {
      overlay = w
      syncOverlay()
      reportActive()
    } else if (!game && isGame(w)) {
      attachGame(w)
    } else if (game === w && !isGame(w)) {
      // title changed away (e.g. launcher -> game window)
      game = null
      send('detach', {})
    }
  }

  var seen = []
  function track (w) {
    if (seen.indexOf(w) !== -1) return
    seen.push(w)
    watchGame(w)
    consider(w)
  }

  function exec (c) {
    if (c.cmd === 'activate-overlay') {
      if (overlay) {
        allowOverlayFocus = true
        overlay.minimized = false
        workspace.activeWindow = overlay
      }
    } else if (c.cmd === 'focus-game') {
      allowOverlayFocus = false
      if (game) workspace.activeWindow = game
    } else if (c.cmd === 'show-overlay') {
      // minimize/unminimize instead of unmap/map: unminimizing doesn't activate
      if (overlay) { overlay.minimized = false; syncOverlay() }
    } else if (c.cmd === 'hide-overlay') {
      if (overlay) overlay.minimized = true
    }
    if (c.seq !== undefined) send('ack', { seq: c.seq })
  }

  function poll () {
    callDBus(cfg.service, cfg.path, cfg.iface, 'NextCommand', function (json) {
      var c = null
      try { c = JSON.parse(json) } catch (e) {}
      if (c && c.cmd !== 'noop') exec(c)
      poll()
    })
  }

  workspace.windowAdded.connect(track)
  workspace.windowRemoved.connect(function (w) {
    var i = seen.indexOf(w)
    if (i !== -1) seen.splice(i, 1)
    if (w === game) {
      game = null
      send('detach', {})
      // another window with the same title may exist
      workspace.windowList().forEach(consider)
    }
    if (w === overlay) overlay = null
  })
  workspace.windowActivated.connect(onActivated)

  workspace.windowList().forEach(track)
  send('ready', {})
  poll()
})()
