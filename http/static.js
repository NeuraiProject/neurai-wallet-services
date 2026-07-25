const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../www");
const TYPES = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".ico": "image/x-icon", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };

function serve(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  if (decoded.includes("\0")) return false;
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (relative.split(/[\\/]/).some((part) => part.startsWith("."))) return false;
  const file = path.resolve(ROOT, relative);
  if (!(file === ROOT || file.startsWith(`${ROOT}${path.sep}`))) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  res.writeHead(200, { "access-control-allow-origin": "*", "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "content-length": stat.size });
  if (req.method === "HEAD") res.end(); else fs.createReadStream(file).pipe(res);
  return true;
}

module.exports = { serve };
