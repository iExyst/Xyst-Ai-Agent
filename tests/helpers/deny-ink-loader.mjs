export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'ink' || specifier === 'react') throw new Error(`optional TUI dependency loaded unexpectedly: ${specifier}`);
  return nextResolve(specifier, context);
}
