// The app screenshot for the tap-a-word pin: book 1, page 1, "scooter" tapped, at iPad portrait size.
// The word card is lifted off the sentence (it normally sits by the word) so the whole page reads.
// node marketing/pinterest/shots.mjs  ->  marketing/pinterest/src/card.png
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('src/card.png', import.meta.url));
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2 });
await p.goto('https://yarareads.finereli.com/#/read/toby-1/0');
await p.waitForTimeout(3000);
await p.click('.w[data-word="scooter"]');
await p.waitForTimeout(1500);
await p.evaluate(() => {
  const pop = document.querySelector('.pop');
  const first = document.querySelector('.w').getBoundingClientRect();
  const w = document.querySelector('.w.active').getBoundingClientRect();
  pop.style.top = (first.top - pop.offsetHeight - 28) + 'px';
  pop.style.left = (w.left + w.width / 2 - pop.offsetWidth / 2) + 'px';
});
await p.waitForTimeout(300);
await p.screenshot({ path: out });
await b.close();
