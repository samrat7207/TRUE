import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// strictPort: fail loudly instead of silently moving to another port.
// host: true = listen on every network interface, so a phone on the same Wi-Fi can open the dev app too.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5176, strictPort: true, host: true },
});
