const staticFiles = require("./static");

const JSON_LIMIT = 2 * 1024 * 1024;

const POST_ROUTES = { "/rpc": "handleRpc" };
// DePIN protocol 1 endpoints. The service no longer requests challenges or
// relays signed calls on a client's behalf: with protocol 2 the client does
// that itself through POST /rpc. Kept for one release as 410 Gone.
const GONE_ROUTES = ["/depin", "/depin/challenge"];
const GONE_BODY = { error: "Gone", description: "DePIN protocol 2: call POST /rpc with the depin* methods. The client requests challenges, signs and encrypts itself; this service no longer does it on its behalf." };
const API_PATHS = ["/whitelist", "/getCache", "/settings", ...Object.keys(POST_ROUTES), ...GONE_ROUTES];

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
    if (req.method === "GET" && (POST_ROUTES[pathname] || GONE_ROUTES.includes(pathname))) return sendJson(res, 405, { description: "Please use the HTTP POST method to proceed. For more details, refer to our documentation." }, { allow: "POST" });
    if (req.method === "POST" && GONE_ROUTES.includes(pathname)) { req.resume(); return sendJson(res, 410, GONE_BODY); }
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
