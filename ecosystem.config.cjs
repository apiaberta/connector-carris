module.exports = {
  apps: [{
    name: 'apiaberta-carris',
    script: 'src/server.js',
    env: {
      NODE_ENV: 'production',
      PORT: 3017,
      MONGO_URI: 'mongodb://localhost:27017/apiaberta-carris',
      VEHICLES_POLL_MS: '90000',
      VEHICLES_PERSIST: 'changed',
      VEHICLES_SNAPSHOT_MAX: '4000',
      VEHICLES_SNAPSHOT_TTL_MS: '600000'
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: '250M',
    node_args: '--max-old-space-size=192'
  }]
}
