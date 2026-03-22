const axios = require('axios');

async function test() {
  console.log("Starting simultaneous requests...");
  const start = Date.now();
  
  try {
    const results = await Promise.all([
      axios.get('http://localhost:4001/api/v1/movies/1241470').then(r => `movie: ${r.status} (${Date.now() - start}ms)`).catch(e => `movie: Error ${e.message} (${Date.now() - start}ms)`),
      axios.get('http://localhost:4001/api/v1/movies/1241470/recommendations').then(r => `rec: ${r.status} (${Date.now() - start}ms)`).catch(e => `rec: Error ${e.message} (${Date.now() - start}ms)`)
    ]);
    
    console.log("Results:", results);
  } catch(e) {
    console.error("Fatal:", e);
  }
}

test();
