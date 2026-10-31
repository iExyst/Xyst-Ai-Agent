const getDesktopInvoke = () => {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  return typeof invoke === 'function' ? invoke : null;
};

const pathLabel = (value) => String(value || '').replace(/[\\/]+$/, '') || value;

export function mountProjectManager({
  dialog,
  currentName,
  currentDetail,
  list,
  status,
  openButton,
  closeButton,
  createButton,
  openFolderButton,
  createDialog,
  createForm,
  nameInput,
  locationLabel,
  cancelCreateButtons,
  isBusy = () => false,
  notify = () => {},
}) {
  let currentPath = '';
  let pending = false;

  function setStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle('is-error', error);
  }

  function setPending(value) {
    pending = value;
    for (const button of [createButton, openFolderButton, ...list.querySelectorAll('button')]) button.disabled = value;
  }

  async function invoke(name, args) {
    const nativeInvoke = getDesktopInvoke();
    if (!nativeInvoke) throw new Error('Project folders can be changed in the Xyst desktop app.');
    const token = document.querySelector('meta[name="xyst-token"]')?.content;
    return nativeInvoke(name, { ...args, token });
  }

  function makeProjectRow(project) {
    const row = document.createElement('div');
    row.className = 'project-list-row';
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'project-list-select';
    select.disabled = pending;
    const icon = document.createElement('span');
    icon.className = 'project-folder-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '▰';
    const copy = document.createElement('span');
    copy.className = 'project-list-copy';
    const name = document.createElement('strong');
    name.textContent = project.name;
    const path = document.createElement('small');
    path.textContent = pathLabel(project.path);
    copy.append(name, path);
    select.append(icon, copy);
    if (project.path === currentPath) {
      const current = document.createElement('span');
      current.className = 'project-current-badge';
      current.textContent = 'Open';
      row.append(select, current);
    } else {
      select.addEventListener('click', () => void switchTo(project.path));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'project-remove-recent';
      remove.textContent = 'Remove from list';
      remove.title = `Remove ${project.name} from the recent list. Its folder and conversations will stay on your computer.`;
      remove.disabled = pending;
      remove.addEventListener('click', () => void removeRecent(project.path));
      row.append(select, remove);
    }
    return row;
  }

  async function refresh() {
    if (!getDesktopInvoke()) {
      currentName.textContent = 'Browser workspace';
      currentDetail.textContent = 'Project folders are available in the desktop app.';
      list.replaceChildren();
      setStatus('Open Xyst AI Assistant on your computer to switch or create project folders.');
      locationLabel.textContent = 'Documents / Xyst Projects';
      return;
    }
    setStatus('Loading projects…');
    try {
      const state = await invoke('list_projects');
      currentPath = state.current_path;
      currentName.textContent = state.current_name || 'Current project';
      currentDetail.textContent = pathLabel(currentPath);
      locationLabel.textContent = pathLabel(state.create_location || 'Documents / Xyst Projects');
      const projects = Array.isArray(state.recent) ? state.recent : [];
      list.replaceChildren();
      if (!projects.length) {
        const empty = document.createElement('p');
        empty.className = 'muted-copy project-empty';
        empty.textContent = 'No recent projects yet. Create one or open a folder to get started.';
        list.append(empty);
      } else {
        for (const project of projects) list.append(makeProjectRow(project));
      }
      setStatus('Your project folders stay on this computer.');
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  async function switchTo(path, action = 'switch_project') {
    if (pending) return;
    if (isBusy() && !window.confirm('A task is still running. Switching projects will stop that task. Would you like to continue?')) return;
    setPending(true);
    setStatus('Opening project…');
    try {
      const switched = await invoke(action, action === 'create_project' ? { name: path } : { path });
      if (switched === false) {
        setPending(false);
        setStatus('This project is already open.');
      }
    } catch (error) {
      setPending(false);
      setStatus(error.message, true);
      notify(error.message);
    }
  }

  async function openFolder() {
    if (pending) return;
    try {
      const path = await invoke('choose_project_folder');
      if (path) await switchTo(path);
    } catch (error) {
      setStatus(error.message, true);
      notify(error.message);
    }
  }

  async function removeRecent(path) {
    try {
      await invoke('remove_recent_project', { path });
      await refresh();
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  openButton.addEventListener('click', () => {
    if (!dialog.open) dialog.showModal();
    void refresh();
  });
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  createButton.addEventListener('click', async () => {
    if (!createDialog.open) {
      await refresh();
      createDialog.showModal();
      nameInput.focus();
    }
  });
  for (const button of cancelCreateButtons) button.addEventListener('click', () => createDialog.close());
  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    createDialog.close();
    void switchTo(name, 'create_project');
  });
  openFolderButton.addEventListener('click', () => void openFolder());

  return { refresh };
}
