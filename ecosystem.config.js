module.exports = {
    apps: [
        {
            name: 'app',
            script: 'dist/src/main.js',
            max_memory_restart: '3G',

            // env_file: '.env',           // <-- this ensures PM2 reads your .env
            env_production: {
                NODE_ENV: 'production',
            },
        },
    ],
};
