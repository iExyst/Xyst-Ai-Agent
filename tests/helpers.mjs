import fs from 'node:fs/promises';
import path from 'node:path';
import { after } from 'node:test';

const temporaryDirectories = new Set();

after(async () => {
  const directories = [...temporaryDirectories];
  temporaryDirectories.clear();
  await Promise.all(directories.map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

export async function createTempDirectory(prefix = 'xyst-test-') {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(prefix))
    throw new TypeError('Temporary directory prefix must contain only letters, numbers, dot, underscore, or hyphen');
  const root = path.join(process.cwd(), '.test-tmp');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, prefix));
  temporaryDirectories.add(directory);
  return directory;
}

export async function createSymlinkOrSkip(t, target, link, type = process.platform === 'win32' ? 'junction' : 'dir') {
  try {
    await fs.symlink(target, link, type);
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) {
      const reason = `Directory symlink creation is unavailable: ${error.code}`;
      if (process.env.XYST_REQUIRE_LINK_TESTS === 'true') throw new Error(reason, { cause: error });
      t.skip(reason);
      return false;
    }
    throw error;
  }
}
