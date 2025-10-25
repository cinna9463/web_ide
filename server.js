// server.js (ES module) — single-workspace file server + PTY + Judge0
import express from 'express';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import path from 'path';
import url from 'url';
import os from 'os';
import fs from 'fs';
import fsPromises from 'fs/promises';
import dotenv from 'dotenv';
dotenv.config();

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Default workspace root -> user's home directory (change via env)
const WORKSPACE_ROOT = path.join(process.env.HOME || os.homedir(),'WorkSpace') ;

// create workspace root if missing
if (!fs.existsSync(WORKSPACE_ROOT)) {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  console.log('Created workspace root:', WORKSPACE_ROOT);
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- Path safety helpers ----------------
// Resolve a user-supplied relative path into an absolute path under WORKSPACE_ROOT.
// rel may be '.' or 'foo/bar' or '/foo' (leading slash is treated as relative to root).
function resolveSafe(rel = '.') {
  // Treat any absolute input as relative to root (strip leading slashes)
  const sanitizedRel = String(rel || '.').replace(/^\/+/, '');
  const resolved = path.resolve(WORKSPACE_ROOT, sanitizedRel);
  // Ensure resolved is inside WORKSPACE_ROOT
  const rootNormalized = path.resolve(WORKSPACE_ROOT) + path.sep;
  const resolvedNormalized = resolved + (resolved.endsWith(path.sep) ? '' : '');
  if (!resolvedNormalized.startsWith(rootNormalized) && resolved !== path.resolve(WORKSPACE_ROOT)) {
    throw new Error('Path outside workspace root is not allowed');
  }
  return resolved;
}

// Turn an absolute resolved path into a workspace-relative path for client (for display).
function toRel(absPath) {
  const rel = path.relative(WORKSPACE_ROOT, absPath);
  return rel === '' ? '.' : rel.replaceAll(path.sep, '/');
}

// ---------------- File APIs ----------------

// GET /api/files?path=relative/path  => list directory
app.get('/api/files', async (req, res) => {
  try {
    const rel = req.query.path || '.';
    const dir = resolveSafe(rel);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Directory not found' });
    const items = await fsPromises.readdir(dir, { withFileTypes: true });
    const out = items.map(it => ({ name: it.name, isDir: it.isDirectory() }));
    // return current path and items
    return res.json({ path: toRel(dir), items: out });
  } catch (err) {
    console.error('GET /api/files error', err);
    return res.status(400).json({ error: err.message });
  }
});

// GET /api/file?path=relative/path/to/file => read file
app.get('/api/file', async (req, res) => {
  try {
    const rel = req.query.path;
    if (!rel) return res.status(400).json({ error: 'path required' });
    const filePath = resolveSafe(rel);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    const content = await fsPromises.readFile(filePath, 'utf8');
    return res.json({ path: toRel(filePath), content });
  } catch (err) {
    console.error('GET /api/file error', err);
    return res.status(400).json({ error: err.message });
  }
});

// POST /api/file  { path: 'rel/to/root', content: '...' } => create/write file
app.post('/api/file', async (req, res) => {
  try {
    const { path: relPath, content } = req.body;
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const abs = resolveSafe(relPath);
    const parent = path.dirname(abs);
    await fsPromises.mkdir(parent, { recursive: true });
    await fsPromises.writeFile(abs, content || '', 'utf8');
    return res.json({ ok: true, path: toRel(abs) });
  } catch (err) {
    console.error('POST /api/file error', err);
    return res.status(400).json({ error: err.message });
  }
});

// POST /api/mkdir { path: 'rel/to/root' }
app.post('/api/mkdir', async (req, res) => {
  try {
    const { path: relPath } = req.body;
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const abs = resolveSafe(relPath);
    await fsPromises.mkdir(abs, { recursive: true });
    return res.json({ ok: true, path: toRel(abs) });
  } catch (err) {
    console.error('POST /api/mkdir error', err);
    return res.status(400).json({ error: err.message });
  }
});

// POST /api/delete { path: 'rel' }
app.post('/api/delete', async (req, res) => {
  try {
    const { path: relPath } = req.body;
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const abs = resolveSafe(relPath);
    const stat = await fsPromises.lstat(abs);
    if (stat.isDirectory()) await fsPromises.rm(abs, { recursive: true, force: true });
    else await fsPromises.unlink(abs);
    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/delete error', err);
    return res.status(400).json({ error: err.message });
  }
});

// Optional: expose the root path to client (safe)
app.get('/api/root', (req, res) => {
  res.json({ root: WORKSPACE_ROOT });
});

// ---------------- Judge0 endpoint (unchanged) ----------------
app.post('/api/run-judge0', async (req, res) => {
  try {
    const { source, language_id, stdin } = req.body;
    if (!source || !language_id) return res.status(400).json({ error: 'source and language_id required' });

    const JUDGE0_URL = process.env.JUDGE0_URL;
    if (!JUDGE0_URL) return res.status(501).json({ error: 'Judge0 not configured' });

    let fetchFn = globalThis.fetch;
    if (!fetchFn) {
      const mod = await import('node-fetch');
      fetchFn = mod.default || mod;
    }

    const b64 = s => Buffer.from(s || '', 'utf8').toString('base64');
    const payload = { source_code: b64(source), language_id: Number(language_id), stdin: stdin ? b64(stdin) : undefined };
    const urlSub = `${JUDGE0_URL.replace(/\/$/, '')}/submissions?base64_encoded=true&wait=true`;
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.JUDGE0_KEY) headers[process.env.JUDGE0_KEY_HEADER || 'X-Auth-Token'] = process.env.JUDGE0_KEY;
    if (process.env.JUDGE0_HOST_HEADER && process.env.JUDGE0_HOST_VALUE) headers[process.env.JUDGE0_HOST_HEADER] = process.env.JUDGE0_HOST_VALUE;

    const r = await fetchFn(urlSub, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!r.ok) {
      const t = await r.text().catch(()=>'');
      return res.status(502).json({ error: `Judge0 ${r.status}`, details: t });
    }
    const json = await r.json();
    const decode = s => s ? Buffer.from(s, 'base64').toString('utf8') : undefined;
    return res.json({
      raw: json,
      stdout: decode(json.stdout),
      stderr: decode(json.stderr),
      compile_output: decode(json.compile_output),
      status: json.status,
      time: json.time,
      memory: json.memory
    });
  } catch (err) {
    console.error('/api/run-judge0 error', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------- Terminal WS ----------------
// WebSocket expects a query param 'path' (relative path under the workspace root).
// If not provided, it will use the workspace root itself.
const server = app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log('Workspace root:', WORKSPACE_ROOT);
});

const wss = new WebSocketServer({ server, path: '/term' });

wss.on('connection', (ws, req) => {
  try {
    const reqUrl = req.url || '';
    const parsed = new URL(reqUrl, `http://${req.headers.host}`);
    const relPath = parsed.searchParams.get('path') || '.';
    const projectDir = resolveSafe(relPath);

    if (!fs.existsSync(projectDir)) {
      ws.send(`Path '${relPath}' not found.`);
      ws.close();
      return;
    }

    const shell = os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: projectDir,
      env: process.env
    });

    console.log(`⚡ Terminal started at: ${projectDir} (pid=${ptyProcess.pid})`);

    ptyProcess.onData(data => {
      try { ws.send(data); } catch {}
    });

    ws.on('message', msg => {
      try {
        const s = msg.toString();
        const parsed = JSON.parse(s);
        if (parsed && parsed.type === 'resize') {
          ptyProcess.resize(parsed.cols || 80, parsed.rows || 24);
          return;
        }
      } catch (e) { /* not json */ }
      ptyProcess.write(msg.toString());
    });

    ws.on('close', () => {
      console.log(`❌ Terminal closed (cwd=${projectDir})`);
      try { ptyProcess.kill(); } catch (e) {}
    });
  } catch (err) {
    console.error('WS connection error', err);
    try { ws.send('Server error'); ws.close(); } catch {}
  }
});
