import 'dotenv/config';

// Works with any provider that serves the OpenAI Chat Completions format
// (DeepSeek, OpenAI, and others). Configure via LLM_BASE_URL / LLM_API_KEY / LLM_MODEL.
const baseUrl = (process.env.LLM_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL ?? 'deepseek-flash';
const abortAfterMs = Number(process.env.ABORT_AFTER_MS ?? 5000);

if (!apiKey) {
  throw new Error('Set LLM_API_KEY first');
}

const controller = new AbortController();
const startedAt = Date.now();

console.log(`[llm] base_url=${baseUrl}`);
console.log(`[llm] model=${model}`);
console.log(`[llm] abort_after_ms=${abortAfterMs}`);

const response = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      {
        role: 'user',
        content:
          'Write a very long technical essay about distributed systems. ' +
          'Continue for as long as the output limit allows. Do not summarize.',
      },
    ],
    max_tokens: 12000,
  }),
  signal: controller.signal,
});

if (!response.ok) {
  throw new Error(`LLM HTTP ${response.status}: ${await response.text()}`);
}

const timer = setTimeout(() => {
  console.log(`[llm] aborting at ${Date.now() - startedAt}ms`);
  controller.abort('controlled-experiment');
}, abortAfterMs);

let buffer = '';
let responseId: string | undefined;
let events = 0;
let outputChars = 0;
let reasoningChars = 0;
let finalUsage: unknown = null;
let sawDone = false;

try {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      for (const line of part.split('\n')) {
        // Skips SSE comments such as ": keep-alive".
        if (!line.startsWith('data: ')) continue;

        const raw = line.slice(6);
        if (raw === '[DONE]') {
          sawDone = true;
          continue;
        }

        try {
          const event = JSON.parse(raw);
          events++;

          if (!responseId && typeof event.id === 'string') {
            responseId = event.id;
            console.log(`[llm] response_id=${responseId}`);
          }

          const delta = event.choices?.[0]?.delta;
          if (typeof delta?.content === 'string') {
            outputChars += delta.content.length;
          }
          if (typeof delta?.reasoning_content === 'string') {
            reasoningChars += delta.reasoning_content.length;
          }

          if (event.usage) {
            finalUsage = event.usage;
          }
        } catch {
          // Ignore non-JSON SSE payloads.
        }
      }
    }
  }
} catch (error) {
  console.log(
    `[llm] stream ended with ${error instanceof Error ? error.name : String(error)}`
  );
} finally {
  clearTimeout(timer);
}

console.log('\n[llm] experiment summary');
console.log(`  response_id: ${responseId ?? 'not observed'}`);
console.log(`  events: ${events}`);
console.log(`  output_chars_received: ${outputChars}`);
console.log(`  reasoning_chars_received: ${reasoningChars}`);
console.log(`  [DONE] received: ${sawDone}`);
console.log(`  final_usage: ${finalUsage ? JSON.stringify(finalUsage) : 'not received'}`);
console.log(`  elapsed_ms: ${Date.now() - startedAt}`);

console.log(
  '\n[llm] IMPORTANT: this proves only that the local HTTP stream was aborted. ' +
  'Use provider-side response/usage information to establish inference and billing behavior.'
);
