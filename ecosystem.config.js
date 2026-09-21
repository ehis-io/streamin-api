module.exports = {
    apps: [
        {
            name: 'app',
            script: 'dist/main.js',
            // Node's own heap is capped below PM2's restart threshold so GC works harder
            // before PM2 has to kill it. Chrome is not counted here — PuppeteerService
            // restarts it on its own (PUPPETEER_MAX_MEMORY_MB).
            node_args: '--max-old-space-size=1024',
            max_memory_restart: '1500M',

            // env_file: '.env',           // <-- this ensures PM2 reads your .env
            env_production: {
                NODE_ENV: 'production',
            },
        },
    ],
};
