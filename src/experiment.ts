import { spawn } from 'node:child_process';

const mode = process.argv[2] === 'ignore' ? 'ignore' : 'honor';

const provider = spawn(
  process.execPath,
  ['--import', 'tsx', 'src/mock-provider.ts', mode],
  { stdio: 'inherit' }
);

const cleanup = () => {
  provider.kill('SIGTERM');
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

await new Promise((resolve) => setTimeout(resolve, 500));

const client = spawn(
  process.execPath,
  ['--import', 'tsx', 'src/client.ts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      PROVIDER_URL: 'http://127.0.0.1:8787/generate',
      ABORT_AFTER_MS: '2000',
    },
  }
);

const clientExit = await new Promise<number | null>((resolve) => {
  client.on('exit', (code) => resolve(code));
});

console.log(`\n[experiment] client exit=${clientExit}`);
console.log('[experiment] observe the provider output above.');
console.log(
  mode === 'honor'
    ? '[experiment] Provider honors disconnect: generation should stop.'
    : '[experiment] Provider ignores disconnect: generation should continue.'
);

await new Promise((resolve) => setTimeout(resolve, 10_500));
cleanup();
