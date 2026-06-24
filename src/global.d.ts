/**
 * Ambient declarations for the `?worker&inline` import suffix used by src/index.ts.
 * The actual bundling is handled by the rollup inlineWorker plugin.
 */
declare module '*?worker&inline' {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

declare module '*?worker' {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}
