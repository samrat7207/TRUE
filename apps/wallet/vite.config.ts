import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// strictPort: fail loudly instead of silently moving to another port, because the QR links use fixed ports.
// The registry contract address, written by scripts/chain-setup.ts before the wallet starts.
const chainFile = '../../data/chain.json';
const registryAddress = existsSync(chainFile) ? JSON.parse(readFileSync(chainFile, 'utf8')).address : '';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // The wallet reads the public registry straight from the chain node. "/chain" forwards to it,
    // so the browser makes a same-origin call.
    proxy: { '/chain': { target: 'http://localhost:8545', rewrite: () => '/' } },
  },
  define: { __REGISTRY_ADDRESS__: JSON.stringify(registryAddress) },
});
