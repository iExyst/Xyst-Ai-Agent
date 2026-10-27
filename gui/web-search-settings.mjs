/** Keep the selected keyless source unless the user explicitly changes it. */
export function resolveWebSearchProvider(patchProvider, currentProvider) {
  if (['automatic', 'brave', 'wikipedia'].includes(patchProvider)) return patchProvider;
  if (['automatic', 'brave', 'wikipedia'].includes(currentProvider)) return currentProvider;
  return 'automatic';
}
