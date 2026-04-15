const { NestFactory } = require('@nestjs/core');
const axios = require('axios');

async function test() {
  console.log("Testing stream API for ID tt32430579...");
  try {
    // Actually, the API requires the TMDB ID usually, not IMDB ID directly for the /streams/:id endpoint,
    // but let's check how the StreamsController uses 'id'.
    // StreamsController :id -> ProvidersService.findStreamLinks(id)
    // ProvidersService parses it as numeric ID: const numericId = parseInt(id);
    // If it's tt32430579, parseInt("tt32430579") returns NaN!
    // Wait, the API for movies takes TMDB ID.
    // The user's frontend is trying to load vsembed.ru/embed/movie?imdb=tt32430579.
    
    // Let's just find the stream link for the actual API call
  } catch(e) { }
}
test();
