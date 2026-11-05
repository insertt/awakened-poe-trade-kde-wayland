// Key code translation for the KDE backend.

// uiohook keycodes are PC scancode set 1 (+0x0E00/0xE000 for extended keys).
// Linux evdev codes are identical to set 1 for codes 1..88.
const EXTENDED: Array<[uiohook: number, evdev: number]> = [
  [0x0E1C, 96], // NumpadEnter -> KEY_KPENTER
  [0x0E1D, 97], // CtrlRight -> KEY_RIGHTCTRL
  [0x0E35, 98], // NumpadDivide -> KEY_KPSLASH
  [0x0E37, 99], // PrintScreen -> KEY_SYSRQ
  [0x0E38, 100], // AltRight -> KEY_RIGHTALT
  [0x0E47, 102], // Home
  [0xE048, 103], // ArrowUp
  [0x0E49, 104], // PageUp
  [0xE04B, 105], // ArrowLeft
  [0xE04D, 106], // ArrowRight
  [0x0E4F, 107], // End
  [0xE050, 108], // ArrowDown
  [0x0E51, 109], // PageDown
  [0x0E52, 110], // Insert
  [0x0E53, 111], // Delete
  [0x0E5B, 125], // Meta -> KEY_LEFTMETA
  [0x0E5C, 126], // MetaRight -> KEY_RIGHTMETA
  // F13..F24 -> KEY_F13 (183) .. KEY_F24 (194)
  ...[0x5B, 0x5C, 0x5D, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x6B]
    .map((u, i): [number, number] => [u, 183 + i])
]
const U2E = new Map(EXTENDED)
const E2U = new Map(EXTENDED.map(([u, e]) => [e, u]))

export function uiohookToEvdev (code: number): number | undefined {
  if (code >= 1 && code <= 88) return code
  return U2E.get(code)
}

export function evdevToUiohook (code: number): number | undefined {
  if (code >= 1 && code <= 88) return code
  return E2U.get(code)
}

export const EVDEV_MODIFIERS: Record<number, 'ctrl' | 'shift' | 'alt' | 'meta'> = {
  29: 'ctrl', 97: 'ctrl', 42: 'shift', 54: 'shift', 56: 'alt', 100: 'alt', 125: 'meta', 126: 'meta'
}

// APT key names (ipc/KeyToCode.ts) -> Qt QKeySequence portable text, as accepted
// by KWin's `registerShortcut`.
const QT_NAMES: Record<string, string> = {
  Backspace: 'Backspace',
  Tab: 'Tab',
  Enter: 'Return',
  CapsLock: 'CapsLock',
  Escape: 'Esc',
  Space: 'Space',
  PageUp: 'PgUp',
  PageDown: 'PgDown',
  End: 'End',
  Home: 'Home',
  ArrowLeft: 'Left',
  ArrowUp: 'Up',
  ArrowRight: 'Right',
  ArrowDown: 'Down',
  Insert: 'Ins',
  Delete: 'Del',
  NumpadMultiply: 'Num+*',
  NumpadAdd: 'Num++',
  NumpadSubtract: 'Num+-',
  NumpadDecimal: 'Num+.',
  NumpadDivide: 'Num+/',
  Semicolon: ';',
  Equal: '=',
  Comma: ',',
  Minus: '-',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  BracketLeft: '[',
  Backslash: '\\',
  BracketRight: ']',
  Quote: "'",
  Ctrl: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift'
}

/** "Ctrl + Shift + D" -> "Ctrl+Shift+D"; returns undefined for unsupported keys */
export function shortcutToQt (shortcut: string): string | undefined {
  const parts: string[] = []
  for (const key of shortcut.split(' + ')) {
    let name = QT_NAMES[key]
    if (name === undefined) {
      if (/^[A-Z0-9]$/.test(key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key)) name = key
      else if (/^Numpad[0-9]$/.test(key)) name = `Num+${key.slice(-1)}`
      else return undefined
    }
    parts.push(name)
  }
  return parts.join('+')
}
