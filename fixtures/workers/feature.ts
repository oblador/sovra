export const createWorker = () => new Worker(
  new URL('./myfeature.worker.ts', import.meta.url),
  { type: 'module' },
);
