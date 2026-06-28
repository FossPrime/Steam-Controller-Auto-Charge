import initWasm, { detect_obstacles } from './wasm-pkg/obstacle_detect.js'

let isReady = false;

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;

  if (type === 'init') {
    try {
      await initWasm();
      isReady = true;
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', error: String(err) });
    }
  } else if (type === 'detect') {
    if (!isReady) return;
    const { rgbaData, width, height, id } = payload;
    try {
      const start = performance.now();
      const jsonStr = detect_obstacles(new Uint8Array(rgbaData), width, height);
      const result = JSON.parse(jsonStr);
      result.processing_time_ms = performance.now() - start;
      self.postMessage({ type: 'result', payload: { result, id } });
    } catch (err) {
      self.postMessage({ type: 'error', error: String(err) });
    }
  }
};
