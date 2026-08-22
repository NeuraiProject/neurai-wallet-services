function getConfig() {
  try {
    const config = require("./config.json");
    return config;
  } catch (e) {
    console.log("Could not find config.json");
    console.log("Please create a config.json file");

    const template = `
    {
      "trusted_proxy_ips": ["127.0.0.1", "::1", "::ffff:127.0.0.1"],
      "depin": {
        "rate_limit": 60,
        "ban_minutes": 10
      },
      "wss": {
        "enabled": true,
        "host": "0.0.0.0",
        "port": 19020,
        "path": "/push",
        "tls_enabled": false,
        "auth_transport": "sec-websocket-protocol",
        "auth_token": "CHANGE-ME-BEFORE-EXPOSING-PUBLICLY",
        "max_sessions": 5000,
        "max_subscriptions_per_session": 200,
        "max_new_connections_per_second": 50,
        "send_initial_state": true,
        "zmq_enabled": true,
        "zmq_endpoint": "tcp://localhost:28332"
      },
      "nodes": [
        {
          "name": "Local Neurai node",
          "username": "dauser",
          "password": "dapassword",
          "neurai_url": "http://localhost:19001"
        }
      ]
    }
      `;

    console.log("Example content of config.json");
    console.info(template);

    process.exit(1);
  }
}

module.exports = getConfig;
