import express from "express";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import path from "path";
import url from "url";
import os from "os";
import fs from "fs";


const app = express();
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const WORKSPACE_ROOT = path.join(__dirname, 'workspaces');


app.use(express.static(path.join(__dirname, 'public')));


const server = app.listen(PORT, () => {
console.log(`✅ Server running on http://localhost:${PORT}`);
});


const wss = new WebSocketServer({ server, path: '/term' });


wss.on('connection', (ws, req) => {
const urlObj = new URL(req.url, `http://${req.headers.host}`);
const project = urlObj.searchParams.get('project') || 'default';
const resolved = path.join(WORKSPACE_ROOT, path.basename(project));


if (!fs.existsSync(resolved)) {
ws.send(`Project '${project}' not found.`);
ws.close();
return;
}


const shell = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash';
const ptyProcess = pty.spawn(shell, [], {
name: 'xterm-color',
cols: 80,
rows: 24,
cwd: resolved,
env: process.env
});


console.log(`⚡ Terminal started for project: ${project}`);


ptyProcess.onData(data => ws.send(data));


ws.on('message', msg => {
try {
const data = JSON.parse(msg.toString());
if (data.type === 'resize') {
ptyProcess.resize(data.cols, data.rows);
}
} catch {
ptyProcess.write(msg.toString());
}
});


ws.on('close', () => {
console.log(`❌ Terminal closed for project: ${project}`);
ptyProcess.kill();
});
});
