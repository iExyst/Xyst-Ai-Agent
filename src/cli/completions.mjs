const INTERACTIVE_COMMANDS = [
  '/budget',
  '/clear',
  '/compact',
  '/exit',
  '/goals',
  '/help',
  '/memory',
  '/mode',
  '/model',
  '/permissions',
  '/quit',
  '/recap',
  '/search',
  '/sessions',
  '/status',
  '/usage',
];

export function createInteractiveCompleter(config) {
  const modelCommands = Object.keys(config.models || {}).map((name) => `/model ${name}`);
  const modeCommands = ['agent', 'plan', 'review'].map((mode) => `/mode ${mode}`);
  return (line) => {
    if (typeof line !== 'string' || !line.startsWith('/')) return [[], line || ''];
    const command = line.split(/\s/, 1)[0];
    const candidates =
      command === '/model' && line.length > '/model'.length
        ? modelCommands
        : command === '/mode' && line.length > '/mode'.length
          ? modeCommands
          : INTERACTIVE_COMMANDS;
    return [candidates.filter((candidate) => candidate.startsWith(line)), line];
  };
}
