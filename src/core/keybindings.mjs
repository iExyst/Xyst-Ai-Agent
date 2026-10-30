export const DEFAULT_UI_SHORTCUTS = Object.freeze({
  toggle_sidebar: 'Ctrl+B',
  new_session: 'Ctrl+K',
  focus_search: '/',
});

const MODIFIED_KEY_PATTERN = /^(?:Ctrl|Alt)(?:\+Shift)?\+[A-Z0-9]$/;

export function isValidUiShortcut(value) {
  return typeof value === 'string' && (value === '/' || MODIFIED_KEY_PATTERN.test(value));
}

export function assertUniqueUiShortcuts(overrides = {}) {
  const actions = Object.keys(DEFAULT_UI_SHORTCUTS);
  if (
    !overrides ||
    typeof overrides !== 'object' ||
    Array.isArray(overrides) ||
    Object.keys(overrides).some((action) => !actions.includes(action))
  )
    throw new TypeError('ui.shortcuts contains an unsupported action');
  const bindings = { ...DEFAULT_UI_SHORTCUTS, ...overrides };
  const assigned = new Map();
  for (const [action, configured] of Object.entries(bindings)) {
    const shortcut = configured === null ? DEFAULT_UI_SHORTCUTS[action] : configured;
    bindings[action] = shortcut;
    if (!isValidUiShortcut(shortcut)) throw new TypeError(`ui.shortcuts.${action} is not a supported key binding`);
    const normalized = shortcut.toLocaleLowerCase('en-US');
    const existing = assigned.get(normalized);
    if (existing) throw new TypeError(`ui.shortcuts.${action} conflicts with ui.shortcuts.${existing}`);
    assigned.set(normalized, action);
  }
  return bindings;
}

export function matchesUiShortcut(event, shortcut) {
  if (shortcut === '/') return event.key === '/' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
  if (!isValidUiShortcut(shortcut)) return false;
  const parts = shortcut.split('+');
  const key = parts.at(-1).toLowerCase();
  const modifier = parts[0];
  const shiftRequired = parts.length === 3;
  return (
    event.key.toLowerCase() === key &&
    (modifier === 'Ctrl' ? event.ctrlKey && !event.altKey && !event.metaKey : event.altKey && !event.ctrlKey && !event.metaKey) &&
    event.shiftKey === shiftRequired
  );
}
