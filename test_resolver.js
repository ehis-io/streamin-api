const axios = require('axios');

async function test(url) {
  console.log("Testing resolver through Gogoanime directly:");
  try {
    const res = await axios.get(`http://localhost:4001/api/v1/streams/100?mediaType=anime&type=sub`);
    console.log(JSON.stringify(res.data.links, null, 2));
  } catch(e) {}
}
test();
