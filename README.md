# LLM Cancellation Boundary Experiment

This repository accompanies the article:

**You Aborted the LLM Request. Did You Actually Stop the AI?**

The experiment deliberately separates three claims:

1. Your Node.js client can abort an HTTP request.
2. The remote provider may or may not stop inference.
3. Provider-side billing/usage must be verified independently.

## Requirements

- Node.js 20+
- pnpm

## Run the controlled local experiment

```bash
pnpm install
pnpm experiment:honor
pnpm experiment:ignore
```

The local mock provider has two modes.

### `HONOR_ABORT`

The mock provider stops its generation loop when the client disconnects.

### `IGNORE_ABORT`

The mock provider deliberately continues generating after the client disconnects.

The client code is identical in both cases.

This demonstrates why:

```text
client-side abort
    !=
provider-side inference termination
```

The mock server is intentionally simple. It is a controlled systems experiment, not a model simulator.

## Real-provider experiment

The package also contains `src/llm-abort.ts`, which works with any provider that serves the OpenAI Chat Completions format (DeepSeek by default).

Set:

```bash
export LLM_API_KEY="..."
export LLM_BASE_URL="https://api.deepseek.com"   # default
export LLM_MODEL="deepseek-flash"                # default
```

Then:

```bash
pnpm experiment:llm
```

The script starts a long streaming Chat Completions request, records the response ID from the first chunk, and aborts the HTTP request after a fixed delay.

Important: this script does **not** claim that an HTTP abort proves billing stopped.

After the run, use the provider's request/usage information available to your account to verify what happened. If your provider does not expose enough information to establish final usage, report the result as "HTTP cancellation verified; provider-side billing outcome unverified."

## Provider-side billing probe

`src/billing-probe.ts` uses the provider's account balance (`GET /user/balance`, DeepSeek) as an external meter:

```bash
pnpm experiment:billing
```

It runs an optional full-length control request, then several requests with a large `max_tokens` that are aborted a few seconds after the first content chunk, and finally waits for the balance to settle.

Things to know before running it:

- It spends real money. With the defaults, the worst case is about 70,000 output tokens.
- The balance has two decimals of CNY and lags by roughly 10 minutes. The script waits up to 25 minutes (`SETTLE_SECONDS`).
- `SKIP_CONTROL=1 CNY_PER_TOKEN=...` skips the control run and reuses a known cost per token.
- Use a quiet account. Other requests during the run would change the balance.
- `ABORT_AFTER_MS` counts from the first content chunk, so each aborted request is cut mid-generation. Run it at two values (for example 3000 and 15000) to check that billing scales with the abort point.
- Aborted streams never deliver `usage`, so received tokens are estimated from characters (`CHARS_PER_TOKEN`, default 5.2, measured on a completed control run).

The measured result is written up in the article.

## Why the article makes this distinction

An `AbortSignal` is local control flow. It can cancel `fetch()` and terminate the response consumption in your application, which makes it the right tool for client disconnects and timeouts.

But the provider is a separate distributed system. Provider-specific semantics determine whether the remote inference stops and how usage is accounted.

For a production system, log at least:

- application request ID
- provider request/response ID
- start time
- first chunk time
- abort time
- final provider status
- provider-reported usage
- cancellation reason
