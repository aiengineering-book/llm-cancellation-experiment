const url = process.env.PROVIDER_URL ?? 'http://127.0.0.1:8787/generate';
const abortAfterMs = Number(process.env.ABORT_AFTER_MS ?? 2000);

const controller = new AbortController();
const startedAt = Date.now();

console.log(`[client] starting request`);
console.log(`[client] abort_after_ms=${abortAfterMs}`);

const response = await fetch(url, {
  signal: controller.signal,
});

const requestId = response.headers.get('x-request-id');
console.log(`[client] provider_request_id=${requestId}`);

if (!response.body) {
  throw new Error('Provider returned no response body');
}

const timer = setTimeout(() => {
  console.log(`[client] aborting at ${Date.now() - startedAt}ms`);
  controller.abort('controlled-experiment');
}, abortAfterMs);

let chunks = 0;
let bytes = 0;

try {
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    chunks++;
    bytes += value.byteLength;

    if (chunks <= 5 || chunks % 10 === 0) {
      console.log(
        `[client] chunk=${chunks} bytes=${value.byteLength} total_bytes=${bytes}`
      );
    }
  }
} catch (error) {
  console.log(
    `[client] stream ended with ${error instanceof Error ? error.name : String(error)}`
  );
} finally {
  clearTimeout(timer);
  console.log(
    `[client] finished elapsed_ms=${Date.now() - startedAt} chunks=${chunks}`
  );
}
