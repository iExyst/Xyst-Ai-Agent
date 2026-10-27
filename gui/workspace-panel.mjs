const element = (tag, className, text) => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
};

export function mountWorkspacePanel({ client, dialog, content, refreshButton, closeButton, onError = () => {} }) {
  let worktreeId = '';
  let relativePath = '';
  let generation = 0;

  async function refresh() {
    const current = ++generation;
    content.replaceChildren(element('p', 'muted-copy', 'Loading workspace…'));
    try {
      const [worktreesResult, view] = await Promise.allSettled([
        client.listWorktrees(),
        client.inspectWorkspace({ path: relativePath, ...(worktreeId ? { worktreeId } : {}) }),
      ]);
      if (view.status === 'rejected') throw view.reason;
      const worktrees = worktreesResult.status === 'fulfilled' ? worktreesResult.value : [];
      if (current !== generation) return;
      const toolbar = element('div', 'workspace-toolbar');
      const picker = element('select', 'data-picker');
      picker.setAttribute('aria-label', 'Workspace or worktree');
      const base = element('option', '', 'Current workspace');
      base.value = '';
      picker.append(base);
      for (const tree of worktrees) {
        const option = element('option', '', `${tree.branch || 'Detached'} · ${tree.id.slice(0, 8)}`);
        option.value = tree.id;
        picker.append(option);
      }
      picker.value = worktreeId;
      picker.addEventListener('change', () => {
        worktreeId = picker.value;
        relativePath = '';
        void refresh();
      });
      const branchInput = element('input', 'workspace-branch-input');
      branchInput.placeholder = 'New branch name';
      branchInput.setAttribute('aria-label', 'New worktree branch name');
      branchInput.maxLength = 200;
      const add = element('button', 'secondary-button', 'Create worktree');
      add.type = 'button';
      add.addEventListener('click', async () => {
        const branch = branchInput.value.trim();
        if (!branch) {
          branchInput.focus();
          return;
        }
        add.disabled = true;
        try {
          const created = await client.createWorktree(branch);
          worktreeId = created.id;
          relativePath = '';
          await refresh();
        } catch (error) {
          onError(error);
          add.disabled = false;
        }
      });
      toolbar.append(picker, branchInput, add);
      if (worktreeId) {
        const selected = worktrees.find((entry) => entry.id === worktreeId);
        const remove = element('button', 'secondary-button workspace-danger-button', 'Remove worktree');
        remove.type = 'button';
        remove.title = 'Only clean worktrees without active runs can be removed';
        remove.addEventListener('click', async () => {
          const label = selected?.branch || worktreeId.slice(0, 8);
          if (
            !window.confirm(
              `Remove managed worktree “${label}”? It must have no uncommitted, untracked, or ignored files and no active run.`,
            )
          )
            return;
          remove.disabled = true;
          try {
            await client.removeWorktree(worktreeId);
            worktreeId = '';
            relativePath = '';
            await refresh();
          } catch (error) {
            onError(error);
            remove.disabled = false;
          }
        });
        toolbar.append(remove);
      }

      const heading = element('div', 'workspace-path-heading');
      const pathLabel = view.path || '.';
      heading.append(
        element(
          'strong',
          '',
          `${worktreeId ? worktrees.find((entry) => entry.id === worktreeId)?.branch || 'Worktree' : 'Workspace'} / ${pathLabel}`,
        ),
      );
      if (view.parent !== null) {
        const up = element('button', 'text-button', 'Up');
        up.type = 'button';
        up.addEventListener('click', () => {
          relativePath = view.parent;
          void refresh();
        });
        heading.append(up);
      }

      const git = element('section', 'workspace-git');
      git.append(element('h3', '', view.git.available ? `Git · ${view.git.branch || 'branch unavailable'}` : 'Git unavailable'));
      if (!view.git.available) git.append(element('p', 'muted-copy', 'This folder is not inside a Git repository.'));
      else if (!view.git.entries.length) git.append(element('p', 'muted-copy', 'Working tree clean.'));
      else {
        const changes = element('ul', 'workspace-change-list');
        for (const change of view.git.entries) {
          const item = element('li');
          item.append(element('code', 'workspace-change-code', change.code), element('span', '', change.path));
          changes.append(item);
        }
        if (view.git.truncated) changes.append(element('li', 'muted-copy', 'Additional changes omitted from this preview.'));
        git.append(changes);
      }

      const tree = element('section', 'workspace-tree');
      tree.append(element('h3', '', `Files (${view.entries.length}${view.truncated ? '+' : ''})`));
      if (!view.entries.length) tree.append(element('p', 'muted-copy', 'This directory is empty.'));
      const list = element('ul', 'workspace-file-list');
      for (const entry of view.entries) {
        const item = element('li');
        const button = element(
          'button',
          'workspace-file-button',
          `${entry.type === 'directory' ? '▸' : '·'} ${entry.name}${entry.type === 'directory' ? '/' : ''}`,
        );
        button.type = 'button';
        button.disabled = entry.type === 'other';
        button.setAttribute('aria-label', entry.type === 'directory' ? `Open folder ${entry.name}` : `Preview file ${entry.name}`);
        button.addEventListener('click', () => {
          if (entry.type === 'directory') {
            relativePath = [relativePath, entry.name].filter(Boolean).join('/');
            void refresh();
          } else void openFile([relativePath, entry.name].filter(Boolean).join('/'));
        });
        item.append(button);
        list.append(item);
      }
      tree.append(list);
      if (view.truncated) tree.append(element('p', 'muted-copy', 'Showing the first 500 entries.'));
      content.replaceChildren(toolbar, heading, git, tree);
    } catch (error) {
      if (current === generation) content.replaceChildren(element('p', 'muted-copy', error.message));
    }
  }

  async function openFile(filePath, targetLine = null) {
    const current = ++generation;
    content.replaceChildren(element('p', 'muted-copy', `Loading ${filePath}…`));
    try {
      const file = await client.readWorkspaceFile({ path: filePath, ...(worktreeId ? { worktreeId } : {}) });
      if (current !== generation) return;
      const heading = element('div', 'workspace-path-heading');
      const back = element('button', 'text-button', 'Back to files');
      back.type = 'button';
      back.addEventListener('click', () => void refresh());
      heading.append(
        element('strong', '', `${file.path} · ${file.bytes.toLocaleString()} bytes${targetLine ? ` · line ${targetLine}` : ''}`),
        back,
      );
      const preview = element('pre', 'workspace-file-preview');
      if (targetLine && file.text) {
        const lines = file.text.split('\n');
        const targetIndex = Math.min(targetLine - 1, lines.length - 1);
        const first = Math.max(0, targetIndex - 8);
        const last = Math.min(lines.length, targetIndex + 9);
        for (let index = first; index < last; index += 1) {
          const lineNumber = index + 1;
          const row = element(
            'span',
            `workspace-file-line${index === targetIndex ? ' workspace-file-line-target' : ''}`,
            `${String(lineNumber).padStart(String(lines.length).length, ' ')} │ ${lines[index]}`,
          );
          preview.append(row);
          if (index < last - 1) preview.append(document.createTextNode('\n'));
        }
        const context = element(
          'p',
          'muted-copy workspace-file-context',
          `Showing lines ${first + 1}–${last} of ${lines.length}${targetLine > lines.length ? `; requested line ${targetLine} is beyond the current file` : ''}.`,
        );
        const fullFile = element('button', 'text-button', 'Show full file');
        fullFile.type = 'button';
        fullFile.addEventListener('click', () => {
          preview.textContent = file.text;
          context.remove();
          fullFile.remove();
        });
        content.replaceChildren(heading, context, fullFile, preview);
      } else {
        preview.textContent = file.text;
        content.replaceChildren(heading, preview);
      }
    } catch (error) {
      if (current !== generation) return;
      const back = element('button', 'text-button', 'Back to files');
      back.type = 'button';
      back.addEventListener('click', () => void refresh());
      content.replaceChildren(back, element('p', 'muted-copy', error.message));
    }
  }

  function open() {
    if (!dialog.open) dialog.showModal();
    void refresh();
  }
  async function openFileAt(filePath, line, worktreePath = null) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.length > 2_000)
      throw new TypeError('Review finding file path is invalid.');
    if (line !== null && line !== undefined && (!Number.isSafeInteger(line) || line < 1))
      throw new TypeError('Review finding line is invalid.');
    worktreeId = '';
    if (worktreePath) {
      const trees = await client.listWorktrees();
      const tree = trees.find((item) => item.path === worktreePath);
      if (!tree) throw new Error('The worktree used by this review is no longer available.');
      worktreeId = tree.id;
    }
    relativePath = '';
    if (!dialog.open) dialog.showModal();
    await openFile(filePath, line ?? null);
  }
  refreshButton.addEventListener('click', () => void refresh());
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  return { open, refresh, openFileAt };
}
