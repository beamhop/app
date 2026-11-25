const { chromium } = require('playwright');
const { start } = require('./server');
(async () => {
  const server = await start();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[console]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(url);
  await page.evaluate(() => window.spikeReady);
  const run = async (cmd, args) => { try { return await page.evaluate(([c, a]) => spike.call(c, a), [cmd, args]); } catch (e) { return 'ERR ' + e.message; } };
  await run('load');
  for (const [c, a] of eval(process.argv[2])) { const t = Date.now(); const r = await Promise.race([run(c, a), new Promise((r) => setTimeout(() => r('TIMEOUT'), 30000))]); console.log(c, Date.now() - t, 'ms', JSON.stringify(r, null, 1)); }
  await browser.close(); server.close();
})();
