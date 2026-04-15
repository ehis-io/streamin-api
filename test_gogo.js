const axios = require('axios');

async function test() {
  console.log("Testing stream API directly...");
  try {
    const res = await axios.get("http://localhost:4001/api/v1/streams/1?mediaType=anime&type=sub");
    console.log(JSON.stringify(res.data, null, 2));
  } catch (e) {
    if (e.response) {
      console.log(e.response.data);
    } else {
      console.log(e.message);
    }
  }
}
test();
