import { parseBubblewrapStatus } from './sandbox.mjs';

const MAX_STATUS_BYTES = 4096;

/** Wait until Bubblewrap confirms the sandbox child has been created. */
export function waitForBubblewrapStart(child, timeoutMs = 10_000) {
  const statusStream = child.stdio?.[3];
  if (!statusStream) return Promise.resolve(false);
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (started) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('error', onEnd);
      child.removeListener('close', onEnd);
      statusStream.removeListener('error', onEnd);
      resolve(started);
    };
    const onData = (chunk) => {
      if (settled || output.length >= MAX_STATUS_BYTES) return;
      output += chunk.subarray(0, MAX_STATUS_BYTES - output.length).toString('utf8');
      if (parseBubblewrapStatus(output).some((entry) => Number.isInteger(entry['child-pid']))) finish(true);
    };
    const onEnd = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    statusStream.on('data', onData);
    statusStream.once('error', onEnd);
    child.once('error', onEnd);
    child.once('close', onEnd);
  });
}
