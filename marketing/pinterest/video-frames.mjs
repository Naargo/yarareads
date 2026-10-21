// Screenshots of the live reader paging through chapter 1 (and "scooter" tapped), for video.sh.
// node marketing/pinterest/video-frames.mjs <dir>
import { chromium } from 'playwright';
const out = process.argv[2];
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2 });
let n = 0;
const shot = async () => p.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}.png` });
for (const i of [0, 1, 3, 4, 5, 6, 8]) {
  await p.goto(`https://yarareads.finereli.com/#/read/toby-1/${i}`); await p.reload(); await p.waitForTimeout(2500);
  await shot();
  if (i === 0) {
    await p.click('.w[data-word="scooter"]'); await p.waitForTimeout(1200);
    await p.evaluate(() => {
      const pop = document.querySelector('.pop'), first = document.querySelector('.w').getBoundingClientRect(), w = document.querySelector('.w.active').getBoundingClientRect();
      pop.style.top = (first.top - pop.offsetHeight - 28) + 'px'; pop.style.left = (w.left + w.width / 2 - pop.offsetWidth / 2) + 'px';
    });
    await p.waitForTimeout(300); await shot();
  }
}
await b.close();
