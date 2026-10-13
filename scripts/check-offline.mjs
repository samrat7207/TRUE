// Fails if the built app could load anything from the internet.   npm run check:offline
// The phones only reach the laptop over Wi-Fi, so the app must not depend on any outside address
// (fonts, CDNs, analytics, images).
//   - HTML and CSS: ANY external address is an error (those are loaded automatically by the browser).
//   - JavaScript: every external host found is listed. A host is allowed only if it is on the short list
//     below of addresses that appear as plain text inside library code and are never requested.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'apps/app/dist';
// Text-only mentions inside bundled libraries (XML namespace names, links printed in error messages,
// and block-explorer / RPC addresses in a library's chain list that this app never selects).
const TEXT_ONLY_HOSTS = [
  'www.w3.org', // SVG / XML namespace names: identifiers, not downloads
  'json-schema.org', // the name of a JSON Schema version inside zod: an identifier, not a download
  'react.dev', // React's "see this page" error links
  'viem.sh', 'abitype.dev', 'oxlib.sh', 'github.com', 'docs.soliditylang.org', // documentation links printed in viem error messages
  '4byte.sourcify.dev', // a "look this up" link printed in a viem error message
  'ipfs.io', 'arweave.net', // default gateways for viem's ENS avatar functions, which this app never calls
  'scanapp.org', // a credit link in the barcode plugin's BROWSER fallback; the Android app uses the native scanner
  'localhost', '127.0.0.1', // the local chain definition and the app's own WebView address
];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const problems = [];
const mentioned = new Map(); // host -> files, for the report
for (const file of files(DIST)) {
  if (!/\.(html|css|js|json|svg)$/.test(file)) continue;
  let text = readFileSync(file, 'utf8');
  if (file.endsWith('.css')) text = text.replace(/\/\*[\s\S]*?\*\//g, ''); // a licence comment is not a download
  for (const match of text.matchAll(/(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,}|localhost|127\.0\.0\.1)[^\s"'`)<>]*/gi)) {
    const host = match[1].toLowerCase();
    if (!match[0].startsWith('http')) continue; // "//" inside comments or regular expressions
    mentioned.set(host, (mentioned.get(host) ?? new Set()).add(file));
    const loadedAutomatically = /\.(html|css|svg)$/.test(file) && host !== 'www.w3.org';
    if (loadedAutomatically || !TEXT_ONLY_HOSTS.includes(host)) problems.push(`${file}: ${match[0].slice(0, 90)}`);
  }
}

console.log('External hosts mentioned in the build:', [...mentioned.keys()].sort().join(', ') || 'none');
if (problems.length > 0) {
  console.error(`\nFAILED: ${problems.length} reference(s) to an outside address that is not on the text-only list:\n` + [...new Set(problems)].slice(0, 30).join('\n'));
  process.exit(1);
}
console.log('OK: the built app does not load anything from an outside address.');
