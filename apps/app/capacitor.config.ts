import type { CapacitorConfig } from '@capacitor/cli';

// Android wrapper for the TRUE app. The web app is built by Vite into dist/ and copied into the APK.
const config: CapacitorConfig = {
  appId: 'app.trueid.wallet',
  appName: 'TRUE',
  webDir: 'dist',
  server: {
    // The app talks to the laptop over plain http on the Wi-Fi. Serving the app itself from http://localhost
    // (instead of https) lets it do that; "localhost" still counts as a secure context, so WebCrypto works.
    androidScheme: 'http',
    cleartext: true,
  },
};

export default config;
