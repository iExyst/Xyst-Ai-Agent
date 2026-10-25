export async function runBoundedOrdered<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Tool batch concurrency must be an integer from 1 through 8");
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}
