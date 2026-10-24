const ENGINE_CACHE = 'engine-opencv-4.12.0';
const ENGINE_BYTES = 10872779;
const aborted = (message = 'Reconstruction cancelled.') => new DOMException(message, 'AbortError');

/** Local-only controller. The only downloaded data is the public, pinned OpenCV runtime. */
export function createEngine({ onStatus, onDownload, onReady } = {}) {
  const engineURL = new URL('./vendor/opencv.js', location.href).href;
  const workerURL = new URL('./reconstruction.worker.js', location.href);
  let worker = null, preparation = null, ready = false, readyResult = null;
  let pending = null, controller = null, disposed = false, generation = 0, runningToken = null;
  const emit = (callback, value) => { try { callback?.(value); } catch (error) { console.warn('Vision status callback failed:', error); } };
  const checkCurrent = token => { if (disposed || token !== generation) throw aborted(); };

  function rejectPending(error) {
    if (!pending) return;
    const job = pending;
    pending = null;
    clearTimeout(job.timer);
    job.reject(error);
  }

  function stopWorker() {
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); worker = null; }
    ready = false;
    readyResult = null;
  }

  function workerFailure(error, ownedWorker) {
    if (ownedWorker !== worker) return;
    rejectPending(error);
    stopWorker();
    preparation = null;
    emit(onStatus, { stage: 'error', progress: 0, message: error.message });
  }

  function startWorker() {
    if (worker) return worker;
    const instance = new Worker(workerURL);
    worker = instance;
    instance.onmessage = ({ data }) => {
      if (instance !== worker) return;
      if (data.type === 'status') emit(onStatus, data);
      else if (data.type === 'error') rejectPending(new Error(data.message || 'The local vision engine failed.'));
      else if ((data.type === 'ready' && pending?.kind === 'init') || (data.type === 'result' && pending?.kind === 'reconstruct')) {
        const job = pending;
        pending = null;
        clearTimeout(job.timer);
        job.resolve(data.type === 'ready' ? { apis: data.apis } : data.model);
      }
    };
    instance.onerror = event => {
      event.preventDefault?.();
      workerFailure(new Error(event.message || 'The local vision worker stopped. Try fewer or smaller views.'), instance);
    };
    instance.onmessageerror = () => workerFailure(new Error('The local vision worker could not read its result. Try again with fewer views.'), instance);
    return instance;
  }

  function request(kind, payload, timeout = 0) {
    if (pending) return Promise.reject(new Error('The local vision engine is already busy.'));
    return new Promise((resolve, reject) => {
      pending = { kind, resolve, reject, timer: timeout ? setTimeout(() => {
        rejectPending(new Error('The local vision engine took too long to start. Reload online and try again.'));
        stopWorker();
        preparation = null;
      }, timeout) : null };
      try { startWorker().postMessage(payload, kind === 'reconstruct' ? payload.frames.map(frame => frame.rgba.buffer) : []); }
      catch (error) { rejectPending(error); }
    });
  }

  async function cacheRuntime(signal, token) {
    let cache = null, cached = null;
    try {
      if (typeof caches !== 'undefined') {
        cache = await caches.open(ENGINE_CACHE);
        cached = await cache.match(engineURL);
        if (!cached) cached = await caches.match(engineURL);
      }
    } catch { /* Private browsing and storage quotas may disable CacheStorage. Online processing remains available. */ }
    checkCurrent(token);
    if (cached?.ok) {
      const total = Number(cached.headers.get('content-length')) || ENGINE_BYTES;
      emit(onDownload, { progress: 1, loaded: total, total, cached: true });
      return true;
    }
    emit(onStatus, { stage: 'loading', progress: 0, message: 'Downloading the local vision engine' });
    emit(onDownload, { progress: 0, loaded: 0, total: ENGINE_BYTES, cached: false });
    const response = await fetch(engineURL, { signal, credentials: 'omit', cache: 'no-cache' });
    if (!response.ok) throw new Error(`Could not download the local vision engine (${response.status}). Open the app online once and retry.`);
    const encoding = response.headers.get('content-encoding');
    const total = (!encoding || encoding === 'identity') && Number(response.headers.get('content-length')) || ENGINE_BYTES;
    const chunks = [];
    let loaded = 0, lastNotice = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          checkCurrent(token);
          chunks.push(value);
          loaded += value.byteLength;
          if (performance.now() - lastNotice > 60) {
            emit(onDownload, { progress: Math.min(0.99, loaded / total), loaded, total, cached: false });
            lastNotice = performance.now();
          }
        }
      } finally { reader.releaseLock(); }
    } else {
      const buffer = await response.arrayBuffer();
      chunks.push(new Uint8Array(buffer));
      loaded = buffer.byteLength;
    }
    checkCurrent(token);
    if (!loaded) throw new Error('The vision engine download was empty. Reload online and try again.');
    let stored = false;
    if (cache) {
      try {
        const body = new Blob(chunks, { type: 'text/javascript' });
        await cache.put(engineURL, new Response(body, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'content-length': String(loaded) } }));
        stored = true;
      } catch { /* Storage failure must not prevent online reconstruction. */ }
    }
    checkCurrent(token);
    emit(onDownload, { progress: 1, loaded, total: loaded, cached: false, stored });
    return stored;
  }

  function prepare() {
    if (disposed) return Promise.reject(new Error('This vision engine has been disposed.'));
    if (preparation) return preparation;
    if (ready) return Promise.resolve(readyResult);
    const token = generation;
    controller = new AbortController();
    preparation = (async () => {
      try {
        const offlineCached = await cacheRuntime(controller.signal, token);
        checkCurrent(token);
        const result = await request('init', { type: 'init' }, 90000);
        checkCurrent(token);
        ready = true;
        readyResult = { ...result, offlineCached };
        emit(onReady, readyResult);
        return readyResult;
      } catch (error) {
        if (token === generation) { preparation = null; stopWorker(); }
        throw error;
      } finally { if (token === generation) controller = null; }
    })();
    return preparation;
  }

  async function reconstruct(frames, options = {}) {
    if (disposed) throw new Error('This vision engine has been disposed.');
    if (runningToken) throw new Error('Reconstruction is already running. Wait or cancel the current session.');
    const operation = Symbol('reconstruction'), token = generation;
    runningToken = operation;
    try {
      await prepare();
      checkCurrent(token);
      // Transfer disposable decoded pixels; compressed source photos remain in the UI for retries.
      return await request('reconstruct', { type: 'reconstruct', frames, options });
    } finally { if (runningToken === operation) runningToken = null; }
  }

  function cancel() {
    generation++;
    controller?.abort();
    controller = null;
    rejectPending(aborted());
    stopWorker();
    preparation = null;
    runningToken = null;
  }

  async function clearCache() {
    cancel();
    if (typeof caches === 'undefined') return;
    await caches.delete(ENGINE_CACHE);
    // The service worker can also cache this exact public asset. Preserve every other URL and cache.
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const url = new URL(request.url);
        const target = new URL(engineURL);
        if (url.origin === target.origin && url.pathname === target.pathname) await cache.delete(request);
      }
    }
  }

  function dispose() { cancel(); disposed = true; }
  return { prepare, reconstruct, cancel, clearCache, dispose, get ready() { return ready; } };
}
