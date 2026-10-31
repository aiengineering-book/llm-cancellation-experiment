import http from 'node:http';

const mode = process.argv[2] === 'ignore' ? 'ignore' : 'honor';
const port = Number(process.env.PORT ?? 8787);

const server = http.createServer((req, res) => {
  if (req.url !== '/generate') {
    res.writeHead(404).end();
    return;
  }

  const requestId = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let generated = 0;
  let disconnected = false;
  let finished = false;

  console.log(`\n[provider] request_id=${requestId} mode=${mode}`);

  req.on('close', () => {
    disconnected = true;
    console.log(`[provider] client disconnected at token=${generated}`);
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Request-Id': requestId,
  });

  const interval = setInterval(() => {
    generated++;

    const event = JSON.stringify({
      requestId,
      token: generated,
      text: `token-${generated}`,
    });

    // Ignore write errors deliberately: the purpose of this mock is to
    // distinguish provider work from the client HTTP connection.
    try {
      res.write(`data: ${event}\n\n`);
    } catch {}

    if (generated >= 100 || (mode === 'honor' && disconnected)) {
      finished = true;
      clearInterval(interval);

      const billed = generated;

      console.log(
        `[provider] FINAL request_id=${requestId} ` +
        `generated=${generated} billed=${billed} ` +
        `reason=${generated >= 100 ? 'completed' : 'client_disconnect'}`
      );

      try {
        res.end();
      } catch {}
    }
  }, 100);

  res.on('close', () => {
    if (!finished && mode === 'ignore') {
      console.log(
        `[provider] HTTP response closed, but generation CONTINUES ` +
        `(request_id=${requestId})`
      );
    }
  });
});

server.listen(port, () => {
  console.log(`[provider] listening on http://127.0.0.1:${port}`);
});
