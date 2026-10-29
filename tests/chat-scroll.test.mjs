import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatScroller } from '../gui/chat-scroll.mjs';

function fixture() {
  const timeline = Object.assign(new EventTarget(), { scrollHeight: 1000, clientHeight: 100 });
  let top = 900;
  Object.defineProperty(timeline, 'scrollTop', {
    get: () => top,
    set: (value) => {
      top = Math.max(0, Math.min(value, timeline.scrollHeight - timeline.clientHeight));
    },
  });
  const button = Object.assign(new EventTarget(), { hidden: true });
  const frames = [];
  const scroller = createChatScroller(timeline, button, { schedule: (callback) => frames.push(callback) });
  scroller.setEnabled(true);
  return {
    timeline,
    button,
    scroller,
    flush: () => {
      while (frames.length) frames.shift()();
    },
  };
}

test('chat follows streamed content until the reader scrolls up, and resumes on request', () => {
  const { timeline, button, scroller, flush } = fixture();
  timeline.scrollHeight = 1200;
  scroller.contentChanged();
  flush();
  assert.equal(timeline.scrollTop, 1100);
  timeline.scrollTop = 300;
  timeline.dispatchEvent(new Event('scroll'));
  timeline.scrollHeight = 1500;
  scroller.contentChanged();
  flush();
  assert.equal(timeline.scrollTop, 300);
  assert.equal(button.hidden, false);
  button.dispatchEvent(new Event('click'));
  flush();
  assert.equal(timeline.scrollTop, 1400);
  assert.equal(button.hidden, true);
});

test('a queued follow operation does not override a reader scrolling up before the next frame', () => {
  const { timeline, button, scroller, flush } = fixture();
  timeline.scrollHeight = 1400;
  scroller.contentChanged();
  timeline.scrollTop = 100;
  timeline.dispatchEvent(new Event('scroll'));
  flush();
  assert.equal(timeline.scrollTop, 100);
  scroller.setEnabled(false);
  assert.equal(button.hidden, true);
});

test('a content-growth scroll event does not cancel the pending auto-scroll', () => {
  const { timeline, scroller, flush } = fixture();
  timeline.scrollHeight = 1600;
  scroller.contentChanged();
  timeline.dispatchEvent(new Event('scroll'));
  flush();
  assert.equal(timeline.scrollTop, 1500);
  assert.equal(scroller.isFollowing(), true);
});
