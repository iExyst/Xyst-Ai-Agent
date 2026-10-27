import React from 'react';
import { Box, Static, Text, render, useInput, useWindowSize } from 'ink';
import { redactSecrets } from '../platform/redaction.mjs';
import { sanitizeTerminalText } from './terminal-text.mjs';

const h = React.createElement;
const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const MAX_ACTIVITY_ITEMS = 8;
const MAX_ACTIVITY_CHARS = 220;
const MAX_APPROVAL_CHARS = 50_000;
const MAX_HISTORY_MESSAGE_CHARS = 12_000;
const MAX_HISTORY_MESSAGES = 200;
const APPROVAL_PAGE_SIZE = 6;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemeBoundaries(value) {
  return [0, ...Array.from(graphemeSegmenter.segment(value), (part) => part.index + part.segment.length)];
}

function snapCursor(value, cursor) {
  const position = Math.max(0, Math.min(value.length, Number.isSafeInteger(cursor) ? cursor : value.length));
  let previous = 0;
  for (const boundary of graphemeBoundaries(value)) {
    if (boundary > position) break;
    previous = boundary;
  }
  return previous;
}

function lineStart(value, cursor) {
  return (cursor > 0 ? value.lastIndexOf('\n', cursor - 1) : -1) + 1;
}

function lineEnd(value, cursor) {
  const nextBreak = value.indexOf('\n', cursor);
  return nextBreak < 0 ? value.length : nextBreak;
}

export function moveVerticalPromptCursor(value, cursor, direction, preferredColumn = null) {
  if (direction !== -1 && direction !== 1) throw new TypeError('direction must be -1 or 1');
  const position = snapCursor(value, cursor);
  const currentStart = lineStart(value, position);
  const currentEnd = lineEnd(value, position);
  if ((direction < 0 && currentStart === 0) || (direction > 0 && currentEnd === value.length)) return null;

  const currentColumn = graphemeBoundaries(value.slice(currentStart, position)).length - 1;
  const column = Number.isSafeInteger(preferredColumn) && preferredColumn >= 0 ? preferredColumn : currentColumn;
  const targetStart = direction < 0 ? lineStart(value, currentStart - 1) : currentEnd + 1;
  const targetEnd = lineEnd(value, targetStart);
  const targetBoundaries = graphemeBoundaries(value.slice(targetStart, targetEnd));
  return {
    cursor: targetStart + targetBoundaries[Math.min(column, targetBoundaries.length - 1)],
    column,
  };
}

function controlKeyName(input, key) {
  if (input.length === 1) {
    const code = input.charCodeAt(0);
    if (code > 0 && code <= 26) return String.fromCharCode(code + 96);
  }
  return key.ctrl ? input.toLowerCase() : '';
}

/** Apply a terminal editing key to a prompt using Unicode grapheme boundaries. */
export function editPromptValue(value, cursor, input = '', key = {}) {
  const position = snapCursor(value, cursor);
  const boundaries = graphemeBoundaries(value);
  const boundaryIndex = boundaries.indexOf(position);
  const control = controlKeyName(input, key);

  if (key.leftArrow) return { input: value, cursor: boundaries[Math.max(0, boundaryIndex - 1)] };
  if (key.rightArrow) return { input: value, cursor: boundaries[Math.min(boundaries.length - 1, boundaryIndex + 1)] };
  if (key.home || control === 'a') return { input: value, cursor: lineStart(value, position) };
  if (key.end || control === 'e') return { input: value, cursor: lineEnd(value, position) };

  if (key.backspace) {
    const previous = boundaries[Math.max(0, boundaryIndex - 1)];
    return previous === position
      ? { input: value, cursor: position }
      : { input: `${value.slice(0, previous)}${value.slice(position)}`, cursor: previous };
  }
  if (key.delete) {
    const next = boundaries[Math.min(boundaries.length - 1, boundaryIndex + 1)];
    return next === position
      ? { input: value, cursor: position }
      : { input: `${value.slice(0, position)}${value.slice(next)}`, cursor: position };
  }
  if (control === 'j') return { input: `${value.slice(0, position)}\n${value.slice(position)}`, cursor: position + 1 };
  if (control === 'u') {
    const start = lineStart(value, position);
    return { input: `${value.slice(0, start)}${value.slice(position)}`, cursor: start };
  }
  if (control === 'k') {
    const end = lineEnd(value, position);
    return { input: `${value.slice(0, position)}${value.slice(end)}`, cursor: position };
  }
  if (!input || control || key.ctrl || key.meta) return { input: value, cursor: position };

  const inserted = input
    .replace(ANSI_SEQUENCE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '');
  return { input: `${value.slice(0, position)}${inserted}${value.slice(position)}`, cursor: position + inserted.length };
}

export function promptDisplayParts(value, cursor) {
  const position = snapCursor(value, cursor);
  const safeValue = displayText(value);
  const safePosition = snapCursor(safeValue, Math.min(safeValue.length, displayText(value.slice(0, position)).length));
  const next = graphemeSegmenter.segment(safeValue.slice(safePosition))[Symbol.iterator]().next().value;
  return {
    before: safeValue.slice(0, safePosition),
    current: next?.segment || '',
    after: safeValue.slice(safePosition + (next?.segment.length || 0)),
  };
}

function cursorText(value, cursor) {
  const { before, current, after } = promptDisplayParts(value, cursor);
  return h(Text, null, before, current ? h(Text, { inverse: true }, current) : h(Text, { color: 'gray' }, '▏'), after);
}

function displayText(value, limit = MAX_HISTORY_MESSAGE_CHARS) {
  const source = value.replace(ANSI_SEQUENCE, '');
  const truncated = source.length > limit;
  const prefix = source.slice(0, limit);
  // Close a private-key block clipped by the display bound so its visible prefix is redacted too.
  const bounded = truncated && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(prefix) ? `${prefix}\n-----END PRIVATE KEY-----` : prefix;
  return sanitizeTerminalText(redactSecrets(bounded)).slice(0, limit);
}

export function conversationMessages(session, limit = MAX_HISTORY_MESSAGES) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('limit must be a non-negative integer');
  if (limit === 0) return [];
  return (session?.messages || [])
    .filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string')
    .slice(-Math.min(limit, MAX_HISTORY_MESSAGES))
    .map((message, index) => ({
      id: `history-${index}`,
      role: message.role,
      text: displayText(message.content).slice(0, MAX_HISTORY_MESSAGE_CHARS),
    }))
    .filter((message) => message.text);
}

/** Keep the live TUI transcript bounded while retaining the newest conversation entries. */
export function appendConversationMessage(history, message) {
  return [...history.slice(-(MAX_HISTORY_MESSAGES - 1)), message];
}

/** Create a persistent Ink surface for prompt input, live run events, and approvals. */
export function createInkTerminal({ workspace, session, model, mode, stdin, stdout }) {
  let view = {
    input: '',
    cursor: 0,
    verticalColumn: null,
    interaction: 'prompt',
    mode: mode || session?.mode || 'agent',
    model: model || session?.model || 'router default',
    status: 'Ready',
    history: conversationMessages(session),
    activities: [],
    draft: '',
    approvalDetails: '',
    approvalDetailsTruncated: false,
    approvalPrompt: '',
    approvalScroll: 0,
    promptHistory: (session?.messages || [])
      .filter((message) => message?.role === 'user' && typeof message.content === 'string')
      .map((message) => message.content)
      .reverse(),
    historyIndex: -1,
  };
  let setRenderedView = null;
  let sessionMessageCount = session?.messages?.length || 0;
  let historySequence = view.history.length;
  let promptResolver = null;
  let approvalResolver = null;
  let approvalRejecter = null;
  let approvalAbortSignal = null;
  let approvalAbortHandler = null;
  let cancelHandler = null;
  let closed = false;
  let app;

  const publish = (patch) => {
    view = { ...view, ...patch };
    setRenderedView?.(view);
  };

  const addActivity = (value, color = 'gray') => {
    const text = displayText(String(value)).replace(/\s+/g, ' ').trim().slice(0, MAX_ACTIVITY_CHARS);
    if (!text) return;
    publish({ activities: [...view.activities, { text, color }].slice(-MAX_ACTIVITY_ITEMS) });
  };

  const clearApprovalWait = () => {
    if (approvalAbortSignal && approvalAbortHandler) approvalAbortSignal.removeEventListener('abort', approvalAbortHandler);
    approvalAbortSignal = null;
    approvalAbortHandler = null;
    approvalResolver = null;
    approvalRejecter = null;
  };

  const submitApproval = (answer) => {
    const resolve = approvalResolver;
    if (!resolve) return;
    clearApprovalWait();
    publish({
      interaction: 'running',
      input: '',
      approvalPrompt: '',
      approvalDetails: '',
      approvalDetailsTruncated: false,
      approvalScroll: 0,
      status: 'Working',
    });
    resolve(answer);
  };

  const handleInput = (input, key) => {
    const control = controlKeyName(input, key);
    if (control === 'c') {
      if (view.interaction === 'approval') cancelHandler?.();
      else if (view.interaction === 'running') cancelHandler?.();
      else if (promptResolver) {
        const resolve = promptResolver;
        promptResolver = null;
        publish({ input: '', cursor: 0, verticalColumn: null, interaction: 'prompt' });
        resolve('/exit');
      }
      return;
    }

    if (view.interaction === 'approval') {
      if (key.pageUp || key.pageDown) {
        const lineCount = view.approvalDetails.split(/\r?\n/).filter(Boolean).length;
        const maxScroll = Math.max(0, lineCount - APPROVAL_PAGE_SIZE);
        const approvalScroll = key.pageUp
          ? Math.max(0, view.approvalScroll - APPROVAL_PAGE_SIZE)
          : Math.min(maxScroll, view.approvalScroll + APPROVAL_PAGE_SIZE);
        return publish({ approvalScroll });
      }
      if (key.return) return submitApproval(view.input.trim());
      if (key.backspace || key.delete) return publish({ input: Array.from(view.input).slice(0, -1).join('') });
      if (input && !key.ctrl && !key.meta) return publish({ input: `${view.input}${input.replace(/[\r\n]/g, '')}` });
      return;
    }

    if (view.interaction !== 'prompt' || !promptResolver) return;
    if (control === 'j' || (input === '\n' && key.name === 'enter')) {
      publish({ ...editPromptValue(view.input, view.cursor, '\n'), historyIndex: -1, verticalColumn: null });
      return;
    }
    if (key.shift && key.return) {
      publish({ ...editPromptValue(view.input, view.cursor, '\n'), historyIndex: -1, verticalColumn: null });
      return;
    }
    if (key.return) {
      const resolve = promptResolver;
      const value = view.input.trim();
      promptResolver = null;
      if (value === '/exit' || value === '/quit') {
        publish({ input: '', cursor: 0, verticalColumn: null });
        resolve(value);
        return;
      }
      const userMessage = value
        ? { id: `history-${historySequence++}`, role: 'user', text: displayText(value).slice(0, MAX_HISTORY_MESSAGE_CHARS) }
        : null;
      publish({
        input: '',
        cursor: 0,
        verticalColumn: null,
        interaction: 'running',
        status: 'Working',
        history: userMessage ? appendConversationMessage(view.history, userMessage) : view.history,
        promptHistory: value ? [value, ...view.promptHistory.filter((entry) => entry !== value)].slice(0, 100) : view.promptHistory,
        historyIndex: -1,
        draft: '',
      });
      resolve(value);
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (view.input.includes('\n')) {
        const movement = moveVerticalPromptCursor(view.input, view.cursor, key.upArrow ? -1 : 1, view.verticalColumn);
        if (movement) publish({ cursor: movement.cursor, verticalColumn: movement.column });
        return;
      }
      if (!view.promptHistory.length) return;
      const historyIndex = key.upArrow
        ? Math.min(view.promptHistory.length - 1, view.historyIndex + 1)
        : Math.max(-1, view.historyIndex - 1);
      const inputValue = historyIndex < 0 ? '' : view.promptHistory[historyIndex];
      publish({ historyIndex, input: inputValue, cursor: inputValue.length, verticalColumn: null });
      return;
    }
    const edited = editPromptValue(view.input, view.cursor, input, key);
    if (edited.input !== view.input || edited.cursor !== view.cursor) publish({ ...edited, historyIndex: -1, verticalColumn: null });
  };

  function Composer() {
    const [renderedView, setView] = React.useState(view);
    const { columns, rows } = useWindowSize();
    setRenderedView = setView;
    const terminalRows = Number.isSafeInteger(rows) ? rows : 24;
    const width = Math.max(1, Number.isFinite(columns) ? columns : 80);
    const activity = renderedView.activities.slice(-Math.max(1, Math.min(5, Math.floor((terminalRows - 14) / 2))));
    const approvalLineLimit = Math.max(1, Math.min(APPROVAL_PAGE_SIZE, terminalRows - 16));
    const allApprovalLines = renderedView.approvalDetails.split(/\r?\n/).filter(Boolean);
    const maxApprovalScroll = Math.max(0, allApprovalLines.length - approvalLineLimit);
    const approvalScroll = Math.min(renderedView.approvalScroll, maxApprovalScroll);
    const approvalLines = renderedView.approvalDetails
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(approvalScroll, approvalScroll + approvalLineLimit);
    const waitingApproval = renderedView.interaction === 'approval';
    const running = renderedView.interaction === 'running' || waitingApproval;

    useInput(handleInput);

    return h(
      Box,
      { flexDirection: 'column', width, paddingX: 1 },
      h(Static, { items: renderedView.history }, (message) =>
        h(
          Box,
          { key: message.id, flexDirection: 'column', marginBottom: 1 },
          h(Text, { bold: true, color: message.role === 'user' ? 'green' : 'magenta' }, message.role === 'user' ? 'You' : 'Xyst'),
          h(Text, { wrap: 'wrap' }, message.text),
        ),
      ),
      h(
        Box,
        { justifyContent: 'space-between', flexWrap: 'wrap' },
        h(Text, { bold: true, color: 'cyan' }, '✦ Xyst AI Assistant'),
        h(Text, { color: 'gray' }, displayText(`${renderedView.mode}  ·  ${renderedView.model}`)),
      ),
      h(Text, { color: 'gray' }, displayText(workspace)),
      renderedView.draft
        ? h(
            Box,
            { flexDirection: 'column', marginTop: 1 },
            h(Text, { bold: true, color: 'magenta' }, 'Xyst'),
            h(Text, { wrap: 'wrap' }, displayText(renderedView.draft)),
          )
        : null,
      ...activity.map((entry, index) => h(Text, { key: `event-${index}`, color: entry.color }, entry.text)),
      waitingApproval
        ? h(
            Box,
            { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1, marginTop: 1 },
            ...approvalLines.map((line, index) => h(Text, { key: `approval-detail-${index}`, wrap: 'wrap' }, displayText(line))),
            renderedView.approvalDetailsTruncated
              ? h(Text, { color: 'yellow' }, 'Preview exceeded the display limit; showing its beginning.')
              : null,
            allApprovalLines.length > approvalLineLimit
              ? h(
                  Text,
                  { color: 'yellow' },
                  `Preview lines ${approvalScroll + 1}–${approvalScroll + approvalLines.length} of ${allApprovalLines.length} · PgUp/PgDn`,
                )
              : null,
            h(Text, { color: 'yellow', bold: true, wrap: 'wrap' }, displayText(renderedView.approvalPrompt).slice(0, 1000)),
            h(Text, { color: 'yellow' }, 'Type y/s/p/c or n, then Enter. PgUp/PgDn scroll preview; Ctrl+C cancels.'),
            h(Text, null, renderedView.input ? displayText(renderedView.input) : h(Text, { color: 'gray' }, 'Approval choice')),
          )
        : h(
            Box,
            { borderStyle: 'round', borderColor: running ? 'magenta' : 'cyan', paddingX: 1, marginTop: 1 },
            h(Text, { color: running ? 'magenta' : 'cyan', bold: true }, running ? '● ' : '› '),
            h(
              Text,
              null,
              renderedView.input
                ? cursorText(renderedView.input, renderedView.cursor)
                : h(Text, { color: 'gray' }, running ? 'Working…' : 'Ask Xyst…'),
            ),
            renderedView.input ? null : h(Text, { color: 'gray' }, '▏'),
          ),
      h(
        Text,
        { color: 'gray', marginTop: 1 },
        `${displayText(renderedView.status)} · Enter send · Ctrl+J/Shift+Enter newline · ←/→ edit · Home/End line · ↑/↓ history · Ctrl+C ${running ? 'cancel' : 'exit'} · ${width}×${terminalRows}`,
      ),
    );
  }

  app = render(h(Composer), { stdin, stdout, exitOnCtrlC: false, patchConsole: false, interactive: true });

  const terminal = {
    readPrompt() {
      if (closed) return Promise.reject(new Error('TUI terminal is closed'));
      if (promptResolver) return Promise.reject(new Error('A TUI prompt is already waiting for input'));
      publish({ interaction: 'prompt', status: 'Ready', input: '', cursor: 0, verticalColumn: null, historyIndex: -1 });
      return new Promise((resolve) => {
        promptResolver = resolve;
      });
    },
    setSession(nextSession) {
      if (!nextSession) {
        sessionMessageCount = 0;
      }
      const messages = nextSession?.messages || [];
      const startIndex = messages.length < sessionMessageCount ? 0 : sessionMessageCount;
      let history = view.history;
      for (const message of messages.slice(startIndex)) {
        if (!['user', 'assistant'].includes(message?.role) || typeof message.content !== 'string') continue;
        const text = displayText(message.content).slice(0, MAX_HISTORY_MESSAGE_CHARS);
        if (!text) continue;
        const last = history.at(-1);
        if (last?.role === message.role && last.text === text) continue;
        history = appendConversationMessage(history, { id: `history-${historySequence++}`, role: message.role, text });
      }
      sessionMessageCount = messages.length;
      publish({
        history,
        ...(nextSession ? {} : { activities: [], draft: '', history: [] }),
        promptHistory: (nextSession?.messages || [])
          .filter((message) => message?.role === 'user' && typeof message.content === 'string')
          .map((message) => message.content)
          .reverse()
          .slice(0, 100),
      });
    },
    setSettings(settings) {
      publish({
        ...(settings.mode === undefined ? {} : { mode: settings.mode || 'agent' }),
        ...(settings.model === undefined ? {} : { model: settings.model || 'router default' }),
      });
    },
    setCancelHandler(handler) {
      cancelHandler = handler;
    },
    setStatus(status) {
      publish({ status: displayText(String(status)) });
    },
    addNotice(message, color = 'gray') {
      const lines = displayText(String(message)).split(/\r?\n/).filter(Boolean);
      const notices = lines.length ? lines : ['(no output)'];
      publish({
        activities: [
          ...view.activities,
          ...notices.slice(0, MAX_ACTIVITY_ITEMS).map((text) => ({ text: text.slice(0, MAX_ACTIVITY_CHARS), color })),
        ].slice(-MAX_ACTIVITY_ITEMS),
      });
    },
    handleEvent(event) {
      if (event.type === 'model_call_started') {
        publish({ status: `Thinking · ${displayText(event.model)} · turn ${event.turn}` });
        return;
      }
      if (event.type === 'assistant_delta') {
        publish({ draft: `${view.draft}${event.text}`.slice(-MAX_HISTORY_MESSAGE_CHARS) });
        return;
      }
      if (event.type === 'tool_proposed') {
        addActivity(`Action proposed · ${event.tool}: ${event.permission?.summary || event.permission?.reason || ''}`, 'yellow');
        return;
      }
      if (event.type === 'tool_started') return addActivity(`Running ${event.tool}…`, 'cyan');
      if (event.type === 'tool_finished')
        return addActivity(`${event.tool} finished${event.summary ? ` · ${event.summary}` : ''}`, 'green');
      if (event.type === 'tool_failed') return addActivity(`${event.tool} failed · ${event.message}`, 'red');
      if (event.type === 'compaction_started') return addActivity('Summarizing earlier conversation context…', 'magenta');
      if (event.type === 'compaction_finished')
        return addActivity(`Context updated · archived ${event.archived_messages} messages`, 'magenta');
      if (event.type === 'compaction_failed') return addActivity(`Context update failed · ${event.message}`, 'red');
      if (event.type === 'run_finished') {
        publish({ status: 'Complete', draft: '', interaction: 'running' });
        return;
      }
      if (event.type === 'run_stopped') {
        publish({ status: 'Stopped', draft: '', interaction: 'running' });
        addActivity(event.reason, 'yellow');
        return;
      }
      if (event.type === 'run_failed') {
        publish({ status: 'Failed', draft: '', interaction: 'running' });
        addActivity(event.message, 'red');
        return;
      }
      if (event.type === 'tool_grant_limit_reached')
        addActivity(`Approval grant limit reached (${event.limit}); approved once only.`, 'yellow');
    },
    approvalInput: {
      question(prompt, { signal } = {}) {
        if (closed) return Promise.reject(new Error('TUI terminal is closed'));
        if (approvalResolver) return Promise.reject(new Error('A TUI approval is already waiting for input'));
        publish({
          interaction: 'approval',
          input: '',
          approvalDetails: '',
          approvalDetailsTruncated: false,
          approvalPrompt: prompt,
          approvalScroll: 0,
          status: 'Approval required',
        });
        return new Promise((resolve, reject) => {
          approvalResolver = resolve;
          approvalRejecter = reject;
          approvalAbortSignal = signal || null;
          if (signal) {
            approvalAbortHandler = () => {
              const abort = approvalRejecter;
              clearApprovalWait();
              publish({
                interaction: 'running',
                input: '',
                approvalPrompt: '',
                approvalDetails: '',
                approvalDetailsTruncated: false,
                approvalScroll: 0,
              });
              abort?.(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
            };
            if (signal.aborted) approvalAbortHandler();
            else signal.addEventListener('abort', approvalAbortHandler, { once: true });
          }
        });
      },
    },
    approvalIo: {
      stdin: { isTTY: true },
      stdout: {
        isTTY: true,
        write(value) {
          const combined = `${view.approvalDetails}${String(value)}`;
          publish({
            approvalDetails: combined.slice(0, MAX_APPROVAL_CHARS),
            approvalDetailsTruncated: view.approvalDetailsTruncated || combined.length > MAX_APPROVAL_CHARS,
          });
          return true;
        },
      },
      stderr: {
        isTTY: true,
        write(value) {
          addActivity(value, 'yellow');
          return true;
        },
      },
    },
    close() {
      if (closed) return;
      closed = true;
      if (promptResolver) {
        const resolve = promptResolver;
        promptResolver = null;
        resolve('/exit');
      }
      if (approvalRejecter) {
        const reject = approvalRejecter;
        clearApprovalWait();
        reject(Object.assign(new Error('The TUI terminal closed'), { name: 'AbortError' }));
      }
      app.unmount();
    },
  };

  return terminal;
}
