import test from 'node:test';
import assert from 'node:assert/strict';
import { mountWorkspacePanel } from '../gui/workspace-panel.mjs';

test('workspace panel renders the selected directory and Git state from the API response', async () => {
  const dialog = fakeElement('dialog');
  const content = fakeElement('div');
  const panel = mountWorkspacePanel({
    client: {
      listWorktrees: async () => [],
      inspectWorkspace: async () => ({
        path: 'src',
        parent: '',
        entries: [{ name: 'agent.mjs', type: 'file' }],
        truncated: false,
        git: { available: true, branch: 'main', entries: [] },
      }),
      readWorkspaceFile: async () => ({ path: 'src/agent.mjs', bytes: 0, text: '' }),
    },
    dialog,
    content,
    refreshButton: fakeElement('button'),
    closeButton: fakeElement('button'),
  });

  await panel.refresh();

  const heading = content.children.find((child) => child.className === 'workspace-path-heading');
  const git = content.children.find((child) => child.className === 'workspace-git');
  const files = content.children.find((child) => child.className === 'workspace-tree');
  assert.match(heading.children[0].textContent, /Main project \/ src/);
  assert.equal(git.children[0].textContent, 'File changes · main');
  assert.equal(files.children[1].children[0].children[0].textContent, '· agent.mjs');
});

test('workspace panel opens a review finding in its bound worktree with a centered line excerpt', async () => {
  const dialog = fakeElement('dialog');
  const content = fakeElement('div');
  const refreshButton = fakeElement('button');
  const closeButton = fakeElement('button');
  const requested = [];
  const worktreePath = 'C:\\workspace\\.agent\\worktrees\\review';
  const panel = mountWorkspacePanel({
    client: {
      listWorktrees: async () => [{ id: 'worktree-1', path: worktreePath }],
      inspectWorkspace: async () => ({ path: '', parent: null, entries: [], truncated: false, git: { available: false, entries: [] } }),
      readWorkspaceFile: async (options) => {
        requested.push(options);
        return { path: options.path, bytes: 300, text: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') };
      },
    },
    dialog,
    content,
    refreshButton,
    closeButton,
  });

  await panel.openFileAt('src/worker.mjs', 16, worktreePath);
  assert.equal(dialog.open, true);
  assert.deepEqual(requested, [{ path: 'src/worker.mjs', worktreeId: 'worktree-1' }]);
  const context = content.children.find((child) => child.className?.includes('workspace-file-context'));
  assert.match(context.textContent, /Showing lines 8–24 of 30/);
  const preview = content.children.find((child) => child.className === 'workspace-file-preview');
  const target = preview.children.find((child) => child.className?.includes('workspace-file-line-target'));
  assert.match(target.textContent, /16 │ line 16/);
  const showFull = content.children.find((child) => child.textContent === 'Show full file');
  showFull.listeners.click();
  assert.equal(preview.textContent.split('\n').length, 30);
});

test('workspace panel refuses a finding from a worktree that is no longer registered', async () => {
  const panel = mountWorkspacePanel({
    client: {
      listWorktrees: async () => [],
      inspectWorkspace: async () => ({ path: '', parent: null, entries: [], truncated: false, git: { available: false, entries: [] } }),
      readWorkspaceFile: async () => assert.fail('A stale worktree finding must not be previewed.'),
    },
    dialog: fakeElement('dialog'),
    content: fakeElement('div'),
    refreshButton: fakeElement('button'),
    closeButton: fakeElement('button'),
  });
  await assert.rejects(panel.openFileAt('src/worker.mjs', 1, 'C:\\workspace\\removed-worktree'), /no longer available/);
});

function fakeElement(tag) {
  return {
    tag,
    children: [],
    listeners: {},
    open: false,
    append(...items) {
      for (const item of items) item.parent = this;
      this.children.push(...items);
    },
    replaceChildren(...items) {
      this.children = items;
      for (const item of items) item.parent = this;
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    setAttribute() {},
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    },
  };
}

globalThis.document = {
  createElement: (tag) => fakeElement(tag),
  createTextNode: (text) => ({ textContent: text }),
};
