(() => {
  const root = document.documentElement;
  const failureMessage = 'The Xyst AI Assistant interface did not finish loading. Reload the app to try again.';
  const errorDetail = (value) => {
    const message =
      typeof value === 'string'
        ? value
        : value && typeof value.message === 'string' && value.message
          ? value.message
          : value?.error && typeof value.error.message === 'string'
            ? value.error.message
            : value?.filename || value?.target?.src || value?.target?.href || '';
    const clean = message
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    return clean ? `${failureMessage} Details: ${clean}` : failureMessage;
  };

  function reportFailure(message) {
    if (root.dataset.xystStartupReported === 'true') return;
    root.dataset.xystStartupReported = 'true';
    const indicator = document.getElementById('connection-indicator');
    if (indicator) {
      indicator.className = 'connection-dot error';
      indicator.title = 'Runtime unavailable';
      indicator.setAttribute('aria-label', 'Runtime unavailable');
    }
    const workspaceStatus = document.getElementById('workspace-status');
    if (workspaceStatus) workspaceStatus.textContent = 'Local · unavailable';
    const banner = document.getElementById('status-banner');
    if (banner) {
      banner.textContent = message;
      banner.hidden = false;
    }
  }

  function reportWhenDomReady(message) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => reportFailure(message), { once: true });
    else reportFailure(message);
  }

  window.addEventListener('error', (event) => reportWhenDomReady(errorDetail(event)), true);
  window.addEventListener('unhandledrejection', (event) => reportWhenDomReady(errorDetail(event?.reason)));
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      if (root.dataset.xystStartupReported === 'true') return;
      setTimeout(() => {
        if (root.dataset.xystStartupReported !== 'true')
          reportFailure('Xyst AI Assistant did not connect to its local runtime within 15 seconds. Reload the app to retry.');
      }, 15_000);
    },
    { once: true },
  );
})();
