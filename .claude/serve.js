// Minimal static file server for previewing the app (no dependencies).
// Local only: binds to 127.0.0.1 and never serves files outside this folder
// or hidden files/folders (.git, .claude, ...).
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.csv': 'text/csv', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.pdf': 'application/pdf' };
http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); }
  catch (e) { res.writeHead(400); return res.end('bad request'); }   // malformed %-escape
  if (p === '/') p = '/index.html';
  const file = path.resolve(root, '.' + p);
  const rel = path.relative(root, file);
  // Outside the folder, or any path segment starting with '.' → refuse.
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) ||
      rel.split(path.sep).some(seg => seg.startsWith('.'))) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(8742, '127.0.0.1', () => console.log('serving on http://127.0.0.1:8742'));
