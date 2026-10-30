import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUniqueUiShortcuts, DEFAULT_UI_SHORTCUTS, isValidUiShortcut, matchesUiShortcut } from '../src/core/keybindings.mjs';

test('shared UI shortcut bindings validate supported modifiers and reject collisions', () => {
  assert.equal(isValidUiShortcut('Ctrl+B'), true);
  assert.equal(isValidUiShortcut('Alt+Shift+7'), true);
  assert.equal(isValidUiShortcut('/'), true);
  assert.equal(isValidUiShortcut('Ctrl+Alt+B'), false);
  assert.equal(isValidUiShortcut('Ctrl+Enter'), false);
  assert.throws(() => assertUniqueUiShortcuts({ new_session: 'Ctrl+B' }), /conflicts with ui\.shortcuts\.toggle_sidebar/);
  assert.deepEqual(assertUniqueUiShortcuts({ toggle_sidebar: 'Alt+B' }), {
    ...DEFAULT_UI_SHORTCUTS,
    toggle_sidebar: 'Alt+B',
  });
});

test('UI shortcut matching requires the configured modifier combination', () => {
  assert.equal(matchesUiShortcut({ key: 'b', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false }, 'Ctrl+B'), true);
  assert.equal(matchesUiShortcut({ key: 'b', ctrlKey: true, altKey: true, metaKey: false, shiftKey: false }, 'Ctrl+B'), false);
  assert.equal(matchesUiShortcut({ key: '7', ctrlKey: false, altKey: true, metaKey: false, shiftKey: true }, 'Alt+Shift+7'), true);
  assert.equal(matchesUiShortcut({ key: '/', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }, '/'), true);
  assert.equal(matchesUiShortcut({ key: '/', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false }, '/'), false);
});

test('resetting a shortcut checks collisions against its restored default', () => {
  assert.throws(() => assertUniqueUiShortcuts({ toggle_sidebar: 'Ctrl+K', new_session: null }), /conflicts/);
  assert.throws(() => assertUniqueUiShortcuts({ toggle_sidebar: null, new_session: 'Ctrl+B' }), /conflicts/);
  assert.deepEqual(assertUniqueUiShortcuts({ toggle_sidebar: null, new_session: null, focus_search: null }), DEFAULT_UI_SHORTCUTS);
});
