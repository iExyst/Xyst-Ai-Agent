/** Follow incoming content until the reader deliberately moves away from the bottom. */
export function createChatScroller(timeline, button, { schedule = requestAnimationFrame } = {}) {
  let following = true;
  let enabled = false;
  let scheduled = false;
  const nearBottom = () => timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= 56;
  const updateButton = () => {
    button.hidden = !enabled || following || nearBottom();
  };
  const scroller = {
    isFollowing: () => following,
    setEnabled(value) {
      enabled = value;
      if (!enabled) following = true;
      updateButton();
    },
    contentChanged() {
      if (scheduled || !enabled) return;
      scheduled = true;
      schedule(() => {
        scheduled = false;
        if (enabled && following) timeline.scrollTop = timeline.scrollHeight;
        updateButton();
      });
    },
    jumpToLatest() {
      following = true;
      timeline.scrollTop = timeline.scrollHeight;
      updateButton();
      scroller.contentChanged();
    },
    restore(top) {
      following = false;
      timeline.scrollTop = top;
      updateButton();
    },
  };
  timeline.addEventListener(
    'scroll',
    () => {
      if (!enabled) return;
      following = nearBottom();
      updateButton();
    },
    { passive: true },
  );
  button.addEventListener('click', () => scroller.jumpToLatest());
  return scroller;
}
