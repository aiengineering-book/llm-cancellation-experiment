import 'dotenv/config';

// Provider-side evidence for the cancellation boundary.
//
// An HTTP abort proves only that the local stream stopped. To learn whether the
// provider kept generating (and billing) after the disconnect, this probe uses
// the account balance as an external meter:
//
//   1. CONTROL: one request that runs to completion. Gives CNY-per-token.
//   2. ABORTED: K requests with a large max_tokens, aborted after a few seconds.
//   3. Compare the balance drop against what each hypothesis predicts.
//
// DeepSeek exposes GET /user/balance with 2 decimals of CNY, so a single small
// request is below resolution. K and max_tokens are sized so that
// "provider kept generating" and "provider stopped" differ by many cents.

const baseUrl = (process.env.LLM_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL ?? 'deepseek-flash';

const controlMaxTokens = Number(process.env.CONTROL_MAX_TOKENS ?? 8000);
const abortedMaxTokens = Number(process.env.ABORTED_MAX_TOKENS ?? 12000);
const abortedRuns = Number(process.env.ABORTED_RUNS ?? 5);
const abortAfterMs = Number(process.env.ABORT_AFTER_MS ?? 3000);
// The balance endpoint lags by roughly 10 minutes, so settle for much longer than a request.
const settleSeconds = Number(process.env.SETTLE_SECONDS ?? 1500);
const skipControl = process.env.SKIP_CONTROL === '1';
const cnyPerTokenOverride = Number(process.env.CNY_PER_TOKEN ?? 0);
// Aborted streams never deliver `usage`, so received tokens are estimated from
// characters. A completed 8,000-token control run measured about 5.2 characters
// per token for this essay prompt; adjust for other prompts or languages.
const charsPerToken = Number(process.env.CHARS_PER_TOKEN ?? 5.2);

if (!apiKey) throw new Error('Set LLM_API_KEY first');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getBalance(): Promise<number> {
  const res = await fetch(`${baseUrl}/user/balance`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`balance HTTP ${res.status}`);
  const body = (await res.json()) as {
    balance_infos: { currency: string; total_balance: string }[];
  };
  const cny = body.balance_infos.find((b) => b.currency === 'CNY') ?? body.balance_infos[0];
  if (!cny) throw new Error('no balance info');
  return Number(cny.total_balance);
}

// Waits until the balance stops changing for `quietMs`, or `maxMs` elapses.
async function settledBalance(quietMs = 300_000, maxMs = settleSeconds * 1000) {
  const start = Date.now();
  let last = await getBalance();
  let lastChange = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(5000);
    const now = await getBalance();
    if (now !== last) {
      last = now;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      break;
    }
  }
  return last;
}

type RunResult = {
  responseId?: string;
  receivedChars: number;
  events: number;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
  sawDone: boolean;
  endedBy: 'completed' | 'abort' | 'error';
  elapsedMs: number;
};

async function run(maxTokens: number, abortMs: number | null): Promise<RunResult> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const result: RunResult = {
    receivedChars: 0,
    events: 0,
    usage: null,
    sawDone: false,
    endedBy: 'completed',
    elapsedMs: 0,
  };

  // The abort timer starts at the first content chunk, so every aborted run
  // is cut mid-generation rather than while still queued.
  let timer: NodeJS.Timeout | undefined;
  const armAbort = () => {
    if (abortMs === null || timer) return;
    timer = setTimeout(() => {
      result.endedBy = 'abort';
      controller.abort('controlled-experiment');
    }, abortMs);
  };

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        stream_options: { include_usage: true },
        thinking: { type: 'disabled' },
        max_tokens: maxTokens,
        messages: [
          {
            role: 'user',
            content:
              'Write a very long technical essay about distributed systems. ' +
              'Continue for as long as the output limit allows. Do not summarize or conclude early.',
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6);
          if (raw === '[DONE]') {
            result.sawDone = true;
            continue;
          }
          try {
            const ev = JSON.parse(raw);
            result.events++;
            if (!result.responseId && typeof ev.id === 'string') result.responseId = ev.id;
            const c = ev.choices?.[0]?.delta?.content;
            if (typeof c === 'string' && c.length > 0) {
              result.receivedChars += c.length;
              armAbort();
            }
            if (ev.usage) result.usage = ev.usage;
          } catch {
            // non-JSON SSE payload
          }
        }
      }
    }
  } catch (error) {
    if (result.endedBy !== 'abort') {
      result.endedBy = 'error';
      console.log(`  error: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    if (timer) clearTimeout(timer);
    result.elapsedMs = Date.now() - startedAt;
  }
  return result;
}

const fmt = (n: number) => n.toFixed(2);

console.log(`[probe] model=${model} base_url=${baseUrl}`);
const b0 = await settledBalance(60_000, 120_000);
console.log(`[probe] starting balance: ${fmt(b0)} CNY`);

// --- 1. CONTROL ---
console.log(skipControl ? '\n[control] skipped' : `\n[control] full run, max_tokens=${controlMaxTokens}`);
const control: RunResult = skipControl
  ? { receivedChars: 0, events: 0, usage: null, sawDone: false, endedBy: 'completed', elapsedMs: 0 }
  : await run(controlMaxTokens, null);
console.log(
  `  id=${control.responseId} chars=${control.receivedChars} ` +
    `usage=${JSON.stringify(control.usage)} done=${control.sawDone} elapsed=${control.elapsedMs}ms`
);
const b1 = skipControl ? b0 : await settledBalance();
const controlCost = b0 - b1;
const controlTokens = (control.usage?.completion_tokens ?? 0) + (control.usage?.prompt_tokens ?? 0);
console.log(`[control] balance ${fmt(b0)} -> ${fmt(b1)}  (cost ${fmt(controlCost)} CNY for ${controlTokens} tokens)`);

// --- 2. ABORTED ---
console.log(`\n[aborted] ${abortedRuns} runs, max_tokens=${abortedMaxTokens}, abort after ${abortAfterMs}ms`);
const aborted: RunResult[] = [];
for (let i = 1; i <= abortedRuns; i++) {
  const r = await run(abortedMaxTokens, abortAfterMs);
  aborted.push(r);
  console.log(
    `  #${i} id=${r.responseId} chars_received=${r.receivedChars} ` +
      `usage=${JSON.stringify(r.usage)} done=${r.sawDone} ended_by=${r.endedBy}`
  );
  await sleep(500);
}
const b2 = await settledBalance();
const abortedCost = b1 - b2;

// --- 3. COMPARE ---
const receivedChars = aborted.reduce((s, r) => s + r.receivedChars, 0);
const approxReceivedTokens = Math.round(receivedChars / charsPerToken);
const cnyPerToken =
  cnyPerTokenOverride > 0
    ? cnyPerTokenOverride
    : controlTokens > 0 && controlCost > 0
      ? controlCost / controlTokens
      : null;

console.log('\n[probe] summary');
console.log(`  control:  ${controlTokens} tokens -> ${fmt(controlCost)} CNY`);
console.log(`  aborted:  balance ${fmt(b1)} -> ${fmt(b2)}  (cost ${fmt(abortedCost)} CNY over ${abortedRuns} runs)`);
console.log(`  aborted runs received about ${approxReceivedTokens} tokens in total (chars / ${charsPerToken})`);
if (cnyPerToken) {
  const impliedTokens = Math.round(abortedCost / cnyPerToken);
  const ifStopped = Math.round(approxReceivedTokens * cnyPerToken * 100) / 100;
  const ifContinued = Math.round(abortedRuns * abortedMaxTokens * cnyPerToken * 100) / 100;
  console.log(`  implied billed tokens: about ${impliedTokens}`);
  console.log(`  prediction if provider stopped at abort:        about ${fmt(ifStopped)} CNY`);
  console.log(`  prediction if provider ran to max_tokens:       about ${fmt(ifContinued)} CNY`);
} else {
  console.log('  control cost below balance resolution; increase CONTROL_MAX_TOKENS');
}
