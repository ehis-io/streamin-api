const axios = require('axios');
const http = require('http');
const https = require('https');
const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');

const url = 'https://api.themoviedb.org/3/trending/movie/day?api_key=8d50e9154080898662f9939a2b764979';

console.log('--- Test 1: Default axios (with global DNS fix) ---');
axios.get(url)
    .then(r => console.log('Test 1 Success:', r.status))
    .catch(e => console.log('Test 1 Fail:', e.message));

console.log('--- Test 2: Native fetch (with global DNS fix) ---');
if (global.fetch) {
    fetch(url)
        .then(r => console.log('Test 2 Success:', r.status))
        .catch(e => console.log('Test 2 Fail:', e.message));
} else {
    console.log('fetch not available');
}
