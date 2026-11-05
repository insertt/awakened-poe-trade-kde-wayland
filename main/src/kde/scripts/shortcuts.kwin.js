// KWin script (Plasma 6): registers global shortcuts via KGlobalAccel.
// Loaded while the game is focused, unloaded when it loses focus. Unloading
// destroys the actions, so keys go back to normal in other apps.
// The config placeholder below is replaced with:
//   { gen, shortcuts: [{ id, name, text, seq }], service, path, iface }
// Each action is named after its key sequence: KGlobalAccel remembers the key
// per action name, so changing the hotkey in APT must produce a new name.
//
// Not the XDG GlobalShortcuts portal (Electron's globalShortcut on Wayland):
// KDE asks the user to confirm every shortcut it hasn't seen before, in a
// dialog that ends up behind the fullscreen game.
(function () {
  var cfg = __CONFIG__
  function send (type, payload) {
    callDBus(cfg.service, cfg.path, cfg.iface, 'Event', type, JSON.stringify(payload))
  }
  cfg.shortcuts.forEach(function (s) {
    var ok = registerShortcut(s.name, s.text, s.seq, function () {
      send('shortcut', { gen: cfg.gen, id: s.id })
    })
    if (ok === false) send('shortcut-failed', { gen: cfg.gen, id: s.id })
  })
  send('shortcuts-ready', { gen: cfg.gen })
})()
