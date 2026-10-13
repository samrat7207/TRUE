// Starts everything with one command: npm run dev
//   1. compile the contract and start the local chain
//   2. deploy and seed the registry (scripts/chain-setup.ts; does only what is missing)
//   3. start the two APIs, the app and the ops console
// Each child process prints with a coloured name prefix.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const children = [];

// shell: true is needed on Windows, where npm is a .cmd file.
function start(label, command, colour) {
  const child = spawn(command, { shell: true });
  const prefix = `\x1b[3${colour}m[${label}]\x1b[0m `;
  const print = (chunk) => {
    for (const line of chunk.toString().split('\n')) if (line.trim()) console.log(prefix + line);
  };
  child.stdout.on('data', print);
  child.stderr.on('data', print);
  children.push(child);
}

// On Windows each child is a shell that started npm that started node, so we must stop the whole tree,
// otherwise the ports stay busy.
function stopAll() {
  for (const child of children) {
    if (process.platform === 'win32') spawnSync(`taskkill /pid ${child.pid} /T /F`, { shell: true });
    else child.kill();
  }
}
process.on('SIGINT', () => { stopAll(); process.exit(0); });

// Run one step and wait for it. If it fails, stop everything: the apps cannot work without the registry.
function runStep(command) {
  const result = spawnSync(command, { shell: true, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\nStep failed: ${command}`);
    stopAll();
    process.exit(1);
  }
}

runStep('npm run compile -w @true/contracts');
start('chain       ', 'npm run dev -w @true/contracts', 1);
runStep('node scripts/chain-setup.ts'); // waits for the chain to answer, then deploys and seeds

// A fresh salt for this run's device labels in the live event feed (see services/*/src/server.ts and proxy.ts).
mkdirSync('data', { recursive: true });
writeFileSync('data/run-salt.txt', crypto.randomUUID());

start('core-api    ', 'npm run dev -w @true/issuer-api', 2);
start('verifier-api', 'npm run dev -w @true/verifier-api', 3);
start('ops-console ', 'npm run dev -w @true/verifier-web', 6);
start('app         ', 'npm run dev -w @true/app', 7);

console.log('\nApp (people and institutions)  http://localhost:5176   (mobile-first: use Chrome Device Toolbar at 390px)\nControl Room (servers, live activity): open the same address on this laptop in a window at least 1100px wide\n');
