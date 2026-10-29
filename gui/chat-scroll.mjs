/** Follow incoming content until the reader deliberately moves away from the bottom. */
export function createChatScroller(timeline, button, { schedule = requestAnimationFrame } = {}) {
  let following = true;
  let enabled = false;
  let scheduled = false;
  let lastScrollTop = timeline.scrollTop;
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
        if (enabled && following) {
          timeline.scrollTop = timeline.scrollHeight;
          lastScrollTop = timeline.scrollTop;
        }
        updateButton();
      });
    },
    jumpToLatest() {
      following = true;
      timeline.scrollTop = timeline.scrollHeight;
      lastScrollTop = timeline.scrollTop;
      updateButton();
      scroller.contentChanged();
    },
    restore(top) {
      following = false;
      timeline.scrollTop = top;
      lastScrollTop = timeline.scrollTop;
      updateButton();
    },
  };
  timeline.addEventListener(
    'scroll',
    () => {
      if (!enabled) return;
      // Content growth can emit a scroll event before the next follow frame.
      // A growing distance from the bottom alone is not a user scrolling up.
      if (nearBottom()) following = true;
      else if (timeline.scrollTop < lastScrollTop - 1) following = false;
      lastScrollTop = timeline.scrollTop;
      updateButton();
    },
    { passive: true },
  );
  button.addEventListener('click', () => scroller.jumpToLatest());
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => scroller.contentChanged()).observe(timeline);
  return scroller;
}
