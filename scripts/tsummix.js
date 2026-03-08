#!/usr/bin/env node
/**
 * Tsummix CLI: transcribe, summarize, mix (RAG later).
 * Start the Discord bot and/or STT wrapper.
 *
 * Usage (after npm link, or node scripts/tsummix.js):
 *   tsummix start        → bot + STT wrapper
 *   tsummix start node   → only Node bot
 *   tsummix start python → only STT wrapper (Python)
 *
 * Expects .venv in repo root with uvicorn when starting Python.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const sub = args[0]; // "start"
const target = args[1]; // undefined | "node" | "python"
const isWin = process.platform === 'win32';

function runBot() {
	const child = spawn('node', ['index.js'], { cwd: root, stdio: 'inherit', shell: isWin });
	child.on('error', (err) => console.error(err));
	child.on('close', (code) => {
		if (code !== 0 && code !== null) process.exitCode = code;
	});
	return child;
}

function runSTT() {
	const uvicorn = isWin
		? path.join(root, '.venv', 'Scripts', 'uvicorn.exe')
		: path.join(root, '.venv', 'bin', 'uvicorn');
	const child = spawn(uvicorn, ['stt-wrapper.app:app'], { cwd: root, stdio: 'inherit', shell: isWin });
	child.on('error', (err) => console.error(err));
	child.on('close', (code) => {
		if (code !== 0 && code !== null) process.exitCode = code;
	});
	return child;
}

function runBoth() {
	const nodeProc = runBot();
	const pythonProc = runSTT();
	process.on('SIGINT', () => {
		nodeProc.kill('SIGINT');
		pythonProc.kill('SIGINT');
	});
}

if (sub !== 'run') {
	console.error('Usage: tsummix run [bot|stt]');
	process.exit(1);
}

if (target === 'bot') {
	runBot();
} else if (target === 'stt') {
	runSTT();
} else if (!target) {
	runBoth();
} else {
	console.error('Usage: tsummix run [bot|stt]');
	process.exit(1);
}
