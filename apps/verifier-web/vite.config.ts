import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// strictPort: fail loudly instead of silently moving to another port, because the QR links use fixed ports.
// The verifier screen is a relying party like any partner, so it sends the same X-API-Key.
// The key is read from the repo's .env at start-up. A key inside a web page is visible to whoever uses
// that page; that is fine for our own kiosk on localhost, and partners keep theirs on their server.
const env = loadEnv('development', '../..', '');
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5175, strictPort: true },
  define: { __VERIFIER_API_KEY__: JSON.stringify(env.PARTNER_API_KEY ?? '') },
});
