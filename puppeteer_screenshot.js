const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function run() {
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--window-size=1280,720'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto("https://vidsrc-embed.ru/embed/tv?tmdb=91768&season=1&episode=1", { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: '/home/ehis/vscode/personal/streaming/streamin-api/screenshot.png' });
  console.log("Screenshot saved.");
  await browser.close();
}

run().catch(console.error);
