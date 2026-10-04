module.exports = {
  apps: [{
    name: "ringring",
    script: "server.js",
    cwd: __dirname,
    node_args: "--env-file=/root/ringringring/.env",
    env: {
      NODE_ENV: "production"
    },
    autorestart: true,
    watch: false,
    max_restarts: 20,
    restart_delay: 2000
  }]
};
