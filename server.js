// server.js (ES module) — fixed imports + PTY + file APIs
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
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(__dirname, 'workspaces');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ensure workspace root exists
if (!fs.existsSync(WORKSPACE_ROOT)) {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  console.log('Created workspace root:', WORKSPACE_ROOT);
}

// helper - resolve workspace path safely
function resolveWorkspacePath(project, rel = '.') {
  if (!project) throw new Error('project name required');
  // sanitize project name: disallow slashes
  const sanitizedProject = path.basename(String(project));
  const projectRoot = path.resolve(WORKSPACE_ROOT, sanitizedProject);
  const resolved = path.resolve(projectRoot, rel || '.');

  if (!resolved.startsWith(projectRoot)) {
    throw new Error('Invalid path (outside project)');
  }
  return { projectRoot, resolved };
}

// ---------------- File APIs ----------------

// GET /api/files?project=project1&path=optional
app.get('/api/files', async (req, res) => {
  try {
    const project = req.query.project;
    const rel = req.query.path || '.';
    if (!project) return res.status(400).json({ error: 'project is required' });

    const { resolved: dir } = resolveWorkspacePath(project, rel);
    console.log('GET /api/files', { project, rel, dir });

    // ensure dir exists
    if (!fs.existsSync(dir)) {
      return res.status(404).json({ error: 'Directory not found', path: rel });
    }

    const items = await fsPromises.readdir(dir, { withFileTypes: true });
    const out = items.map(it => ({ name: it.name, isDir: it.isDirectory() }));
    res.json({ path: rel, items: out });
  } catch (err) {
    console.error('GET /api/files error', err);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/file?project=project1&path=somefile.js
app.get('/api/file', async (req, res) => {
  try {
    const project = req.query.project;
    const rel = req.query.path;
    if (!project || !rel) return res.status(400).json({ error: 'project and path are required' });

    const { resolved: filePath } = resolveWorkspacePath(project, rel);
    console.log('GET /api/file', { project, rel, filePath });

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    const content = await fsPromises.readFile(filePath, 'utf8');
    res.json({ path: rel, content });
  } catch (err) {
    console.error('GET /api/file error', err);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/file  { project, path, content }
app.post('/api/file', async (req, res) => {
  try {
    const { project, path: relPath, content } = req.body;
    if (!project || !relPath) return res.status(400).json({ error: 'project and path are required' });

    const { resolved: filePath, projectRoot } = resolveWorkspacePath(project, relPath);
    console.log('POST /api/file', { project, relPath, filePath });

    // ensure project root exists
    if (!fs.existsSync(projectRoot)) await fsPromises.mkdir(projectRoot, { recursive: true });

    // ensure parent dir exists
    const parent = path.dirname(filePath);
    await fsPromises.mkdir(parent, { recursive: true });

    await fsPromises.writeFile(filePath, content || '', 'utf8');
    res.json({ ok: true, path: relPath });
  } catch (err) {
    console.error('POST /api/file error', err);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/mkdir { project, path }
app.post('/api/mkdir', async (req, res) => {
  try {
    const { project, path: relPath } = req.body;
    if (!project || !relPath) return res.status(400).json({ error: 'project and path are required' });

    const { resolved: dirPath, projectRoot } = resolveWorkspacePath(project, relPath);
    console.log('POST /api/mkdir', { project, relPath, dirPath });

    if (!fs.existsSync(projectRoot)) await fsPromises.mkdir(projectRoot, { recursive: true });

    await fsPromises.mkdir(dirPath, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/mkdir error', err);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/delete { project, path }
app.post('/api/delete', async (req, res) => {
  try {
    const { project, path: relPath } = req.body;
    if (!project || !relPath) return res.status(400).json({ error: 'project and path are required' });

    const { resolved: target } = resolveWorkspacePath(project, relPath);
    console.log('POST /api/delete', { project, relPath, target });

    const stat = await fsPromises.lstat(target);
    if (stat.isDirectory()) await fsPromises.rm(target, { recursive: true, force: true });
    else await fsPromises.unlink(target);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/delete error', err);
    res.status(400).json({ error: err.message });
  }
});

// helper for base64 encode
function b64(s){ return Buffer.from(s, 'utf8').toString('base64'); }


// ===== Judge0 submission endpoint (supports RapidAPI) =====
app.post('/api/run-judge0', async (req, res) => {
  try {
    const { project, source, language_id, stdin } = req.body;
    if (!project || !source || !language_id) {
      return res.status(400).json({ error: 'project, source and language_id are required' });
    }

    const JUDGE0_URL = process.env.JUDGE0_URL; // e.g. https://judge0-ce.p.rapidapi.com
    if (!JUDGE0_URL) return res.status(501).json({ error: 'Judge0 not configured. Set JUDGE0_URL.' });

    // get fetch (global in Node 18+, otherwise dynamic import)
    let fetchFn = globalThis.fetch;
    if (!fetchFn) {
      const mod = await import('node-fetch');
      fetchFn = mod.default || mod;
    }

    // prepare base64 payload
    const b64 = s => Buffer.from(s || '', 'utf8').toString('base64');
    const payload = {
      source_code: b64(source),
      language_id: Number(language_id),
      stdin: stdin ? b64(stdin) : undefined
    };

    // Compose request url (use wait=true for sync result)
    const url = `${JUDGE0_URL.replace(/\/$/, '')}/submissions?base64_encoded=true&wait=true`;

    // Build headers - support either X-Auth-Token style OR RapidAPI style
    const headers = { 'Content-Type': 'application/json' };

    if (process.env.JUDGE0_KEY) {
      // default header name (can be overridden)
      const keyHeader = process.env.JUDGE0_KEY_HEADER || 'X-Auth-Token';
      headers[keyHeader] = process.env.JUDGE0_KEY;
    }

    // RapidAPI requires host header too (e.g. x-rapidapi-host: judge0-ce.p.rapidapi.com)
    if (process.env.JUDGE0_HOST_HEADER && process.env.JUDGE0_HOST_VALUE) {
      headers[process.env.JUDGE0_HOST_HEADER] = process.env.JUDGE0_HOST_VALUE;
    }

    const r = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const text = await r.text().catch(()=>'');
      return res.status(502).json({ error: `Judge0 responded ${r.status}`, details: text });
    }

    const json = await r.json();
    const decode = s => (s ? Buffer.from(s, 'base64').toString('utf8') : undefined);

    const result = {
      raw: json,
      stdout: decode(json.stdout),
      stderr: decode(json.stderr),
      compile_output: decode(json.compile_output),
      status: json.status,
      time: json.time,
      memory: json.memory
    };

    res.json(result);
  } catch (err) {
    console.error('/api/run-judge0 error', err);
    res.status(500).json({ error: err.message });
  }
});



// ---------------- Terminal WS ----------------

const server = app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log('Workspace root:', WORKSPACE_ROOT);
});

const wss = new WebSocketServer({ server, path: '/term' });

wss.on('connection', (ws, req) => {
  const reqUrl = req.url || '';
  const parsed = new URL(reqUrl, `http://${req.headers.host}`);
  const project = parsed.searchParams.get('project') || 'default';
  const safeProject = path.basename(project);
  const projectDir = path.join(WORKSPACE_ROOT, safeProject);

  if (!fs.existsSync(projectDir)) {
    ws.send(`Project '${project}' not found.`);
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

  console.log(`⚡ Terminal started for project: ${project} (pid=${ptyProcess.pid})`);

  ptyProcess.onData(data => {
    try { ws.send(data); } catch (e) {}
  });

  ws.on('message', msg => {
    try {
      const s = msg.toString();
      const parsed = JSON.parse(s);
      if (parsed && parsed.type === 'resize') {
        ptyProcess.resize(parsed.cols || 80, parsed.rows || 24);
        return;
      }
    } catch (e) {
      // not JSON
    }
    ptyProcess.write(msg.toString());
  });

  ws.on('close', () => {
    console.log(`❌ Terminal closed for project: ${project}`);
    try { ptyProcess.kill(); } catch (e) {}
  });
});
