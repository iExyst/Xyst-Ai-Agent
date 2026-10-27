import os from 'node:os';
import path from 'node:path';

/** User-level storage for cross-project data. Project state remains in .agent. */
export function defaultUserDataDirectory(env = process.env, platform = process.platform, home = os.homedir()) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') return pathApi.join(env.LOCALAPPDATA || pathApi.join(home, 'AppData', 'Local'), 'Xyst AI Assistant');
  return pathApi.join(env.XDG_DATA_HOME || pathApi.join(home, '.local', 'share'), 'xyst');
}
