const process = require("process");
const getConfig = require("./getConfig");
const wss = require("./wss");
const httpServiceMod = require("./http");
const httpStandalone = require("./http/standalone");
const { resolveTrustedProxies } = require("./clientIp");
const { resolveDepinConfig } = require("./depinRateLimit");

process.on("uncaughtException", (error, origin) => {
  console.log("----- Uncaught exception -----");
  console.log(error);
  console.log("----- Exception origin -----");
  console.log(origin);
});

process.on("unhandledRejection", (reason, promise) => {
  console.log("----- Unhandled Rejection at -----");
  console.log(promise);
  console.log("----- Reason -----");
  console.log(reason);
});

const config = getConfig();
const wssEnabled = Boolean(config.wss && config.wss.enabled === true);
const httpEnabled = Boolean(config.http && config.http.enabled === true);

if (!wssEnabled && !httpEnabled) {
  console.log("[config] wss.enabled and http.enabled are both off. Nothing to start.");
  process.exit(0);
}

try {
  // Root-level settings shared by both transports; fail early and clearly.
  resolveTrustedProxies(config);
  resolveDepinConfig(config);
  const httpService = httpServiceMod.create(config.http, config);
  if (wssEnabled) {
    // HTTP, when enabled, shares the WSS listener (its port, host and TLS).
    wss.start(config.wss, config, httpService);
  } else {
    httpStandalone.start(config.http, httpService);
  }
} catch (e) {
  console.log(`[${wssEnabled ? "WSS" : "HTTP"}] failed to start:`, e && e.message ? e.message : e);
  process.exit(1);
}
