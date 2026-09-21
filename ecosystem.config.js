module.exports = {
    apps: [
        {
            name: 'app',
            script: 'dist/main.js',
            // Sized for the ~900MB production box. Node's heap is capped below PM2's
            // restart threshold so GC works harder before PM2 has to kill it. Chrome is
            // not counted here — PuppeteerService restarts it on its own
            // (PUPPETEER_MAX_MEMORY_MB, set in the repo's GitHub variables).
            node_args: '--max-old-space-size=320',
            max_memory_restart: '450M',

            // env_file: '.env',           // <-- this ensures PM2 reads your .env
            env_production: {
                NODE_ENV: 'production',
            },
        },
    ],
};
