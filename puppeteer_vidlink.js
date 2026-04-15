const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function run() {
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  await page.setRequestInterception(true);
  const m3u8_urls = [];
  page.on('request', request => {
    const url = request.url();
    if (url.includes('.m3u8')) m3u8_urls.push(url);
    request.continue();
  });
  
  await page.goto("https://vidlink.pro/tv/281392/1/1?primaryColor=e50914&player=default&autoplay=true", { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 4000));
  
  console.log("Found M3U8s:", m3u8_urls);
  await browser.close();
}

run().catch(console.error);
