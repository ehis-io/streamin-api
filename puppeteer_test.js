const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function run() {
  console.log("Launching browser...");
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  await page.setRequestInterception(true);
  
  const m3u8_urls = [];
  page.on('request', request => {
    const url = request.url();
    if (url.includes('.m3u8')) {
      console.log("FOUND M3U8:", url);
      m3u8_urls.push(url);
    }
    request.continue();
  });
  
  console.log("Navigating to vidsrc-embed.ru...");
  await page.goto("https://vidsrc-embed.ru/embed/tv?tmdb=91768&season=1&episode=1", { waitUntil: 'networkidle2', timeout: 30000 });
  
  console.log("Waiting 2s...");
  await new Promise(r => setTimeout(r, 2000));
  
  console.log("Clicking center of screen...");
  const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  await page.mouse.click(viewport.w / 2, viewport.h / 2);
  await new Promise(r => setTimeout(r, 1000));
  await page.mouse.click(viewport.w / 2, viewport.h / 2);
  
  console.log("Waiting 5s for network requests...");
  await new Promise(r => setTimeout(r, 5000));
  
  console.log("Check complete. Found M3U8s:", m3u8_urls.length);
  await browser.close();
}

run().catch(console.error);
