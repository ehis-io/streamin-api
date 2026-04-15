const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const axios = require('axios');

async function test() {
  console.log("Checking DB for recent active queries or logs...");
  // Let's just fetch trending movies to get a real ID, then query /streams
  const res = await axios.get("http://localhost:4001/api/v1/movies/trending");
  const id = res.data.results[0].id;
  
  console.log(`Testing stream API for trending movie ID ${id}...`);
  const start = Date.now();
  try {
    const streamRes = await axios.get(`http://localhost:4001/api/v1/streams/${id}`);
    console.log(`Finished in ${Date.now() - start}ms`);
    console.log(`Links found: ${streamRes.data.links.length}`);
  } catch(e) {
    console.log("Error:", e.message);
  }
  await prisma.$disconnect();
}
test();
