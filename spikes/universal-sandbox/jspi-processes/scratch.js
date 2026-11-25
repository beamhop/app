// dev helper: node scratch.js "[['cmd',{args}],...]"  (each command gets 10 s)
const { chromium } = require('playwright');
const { start } = require('./server');
(async () => {
  const server = await start();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let crashed;
  const crash = new Promise((r) => (crashed = r));
  page.on('console', (m) => console.log('[console]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('crash', () => crashed('PAGE CRASHED'));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => window.spikeReady);
  const run = (cmd, args) => page.evaluate(([c, a]) => spike.call(c, a), [cmd, args]).catch((e) => 'ERR ' + e.message.slice(0, 300));
  await run('load');
  for (const [c, a] of eval(process.argv[2])) {
    const t = Date.now();
    const r = await Promise.race([run(c, a), crash, new Promise((r) => setTimeout(() => r('TIMEOUT'), +process.argv[3] || 10000))]);
    console.log(c, Date.now() - t, 'ms', JSON.stringify(r, null, process.argv[4] ? 1 : 0));
  }
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
})();
