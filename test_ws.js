const io = require('socket.io-client');
const socket = io('http://localhost:4001');

socket.on('connect', () => {
    console.log('Connected, sending request for TV show...');
    socket.emit('find-streams', {
        id: '281006',
        season: 1,
        episode: 1,
        type: 'sub',
        mediaType: 'tv',
        requestId: 'test1234'
    });
});

socket.on('stream-link', (data) => {
    console.log('Found stream:', data.link.url, 'Quality:', data.link.quality);
});

socket.on('streams-complete', (data) => {
    console.log('Search complete! Total streams:', data.links ? data.links.length : data.length);
    if (data.scraperStatuses) {
        console.log('Scraper Statuses:', JSON.stringify(data.scraperStatuses, null, 2));
    }
    process.exit(0);
});

socket.on('connect_error', (err) => {
    console.log('Connection Error:', err.message);
    process.exit(1);
});

setTimeout(() => {
    console.log('Timeout reached');
    process.exit(1);
}, 30000);
