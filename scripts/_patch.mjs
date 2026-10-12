import { readFileSync, writeFileSync } from 'node:fs';

export function patch(file, pairs) {
  let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(file + ' not found: ' + from.slice(0, 70));
    text = text.replace(from, () => to);
  }
  writeFileSync(file, text);
}

