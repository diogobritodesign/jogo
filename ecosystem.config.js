module.exports = {
  apps: [
    {
      name: 'system-breach',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        // ── PORT is the ONLY place where the default port is defined. ──
        // server.js reads process.env.PORT and will refuse to start if it
        // is not set, so always keep this value here.
        PORT: 3000,
      },
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
