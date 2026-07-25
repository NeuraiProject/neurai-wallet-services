const staticFiles = require("./static");

const JSON_LIMIT = 2 * 1024 * 1024;

const POST_ROUTES = { "/rpc": "handleRpc", "/depin": "handleDePin", "/depin/challenge": "handleDePinChallenge" };
const API_PATHS = ["/whitelist", "/getCache", "/settings", ...Object.keys(POST_ROUTES)];

function sendJson(res, status, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { "access-control-allow-origin": "*", "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > JSON_LIMIT) { tooLarge = true; reject(Object.assign(new Error("body too large"), { status: 413 })); req.resume(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("invalid json"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function createHandler(deps) {
  return async (req, res) => {
    // Do not use URL here: it normalizes `/../` before static.js can reject it.
    const pathname = (req.url || "/").split("?", 1)[0] || "/";
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, POST, OPTIONS", "access-control-allow-headers": "content-type" }); res.end(); return;
    }
    if (API_PATHS.includes(pathname) && !deps.tryAccept(req)) {
      return sendJson(res, 429, { error: "rate limit exceeded" }, { "retry-after": "1" });
    }
    if (req.method === "GET" && pathname === "/whitelist") return sendJson(res, 200, deps.whitelist);
    if (req.method === "GET" && pathname === "/getCache") return sendJson(res, 200, deps.getCache());
    if (req.method === "GET" && pathname === "/settings") return sendJson(res, 200, deps.settings);
    // Body text kept verbatim from the retired proxy's GET /rpc response.
    if (req.method === "GET" && POST_ROUTES[pathname]) return sendJson(res, 405, { description: "Please use the HTTP POST method to proceed. For more details, refer to our documentation." }, { allow: "POST" });
    const postRoute = req.method === "POST" ? POST_ROUTES[pathname] : undefined;
    if (postRoute) {
      try {
        const body = await readJsonBody(req);
        if (req.aborted || res.destroyed) return;
        return deps[postRoute](body, req, res);
      } catch (e) { return sendJson(res, e.status || 400, { error: e.status === 413 ? "request body too large" : "invalid JSON body" }); }
    }
    if ((req.method === "GET" || req.method === "HEAD") && deps.serveWww && staticFiles.serve(req, res, pathname)) return;
    return sendJson(res, 404, { error: "not found" });
  };
}

module.exports = { createHandler, sendJson };
