const axios = require('axios');

async function test() {
  console.log("Testing stream API for ID 1 (Cowboy Bebop)...");
  try {
    const res = await axios.get("http://localhost:4001/api/v1/streams/1?mediaType=anime&type=sub");
    
    const links = res.data.links;
    const m3u8Links = links.filter(l => l.isM3U8);
    const iframeLinks = links.filter(l => !l.isM3U8);
    
    console.log(`Found ${links.length} total links`);
    console.log(`M3U8 Links: ${m3u8Links.length}`);
    m3u8Links.forEach(l => console.log(`  - [M3U8] ${l.url.substring(0, 80)}...`));
    
    console.log(`Iframe Links: ${iframeLinks.length}`);
    iframeLinks.forEach(l => console.log(`  - [IFRAME] ${l.url.substring(0, 80)}...`));
    
    console.log("\nScraper Statuses:");
    console.log(JSON.stringify(res.data.scraperStatuses, null, 2));
  } catch (e) {
    console.error("Test failed:", e.message);
  }
}
test();
