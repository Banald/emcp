module.exports = {
  apps: [
    {
      name: 'mcp-server',
      script: './dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      kill_timeout: 35000, // SHUTDOWN_TIMEOUT_MS (30s) + 5s margin
      wait_ready: false,
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'mcp-worker',
      script: './dist/workers/index.js',
      instances: 1,
      exec_mode: 'fork',
      kill_timeout: 65000, // worker SHUTDOWN_TIMEOUT_MS (60s) + 5s margin
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
