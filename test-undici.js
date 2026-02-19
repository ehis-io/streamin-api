const { setGlobalDispatcher, Agent } = require('undici');
const axios = require('axios');
const http = require('http');
const https = require('https');

// Force IPv4 for undici (native fetch)
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

const url = 'https://api.themoviedb.org/3/trending/movie/day?api_key=8d50e9154080898662f9939a2b764979';

console.log('--- Test: Native fetch (with global undici IPv4 dispatcher) ---');
fetch(url)
    .then(r => console.log('Fetch Success:', r.status))
    .catch(e => console.log('Fetch Fail:', e.message));

console.log('--- Test: axios (default) ---');
axios.get(url)
    .then(r => console.log('axios Success:', r.status))
    .catch(e => console.log('axios Fail:', e.message));
