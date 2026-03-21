#!/usr/bin/env node
/**
 * Tsummix CLI: transcribe, summarize, mix (RAG later).
 * Start the Discord bot and/or STT wrapper.
 *
 * Usage (after npm link, or node scripts/tsummix.js):
 *   tsummix run                       → bot + STT wrapper (local processes)
 *   tsummix run --distribute | -d     → bot + worker + STT wrapper (worker over HTTP, no Docker)
 *   tsummix run bot                   → only Node bot
 *   tsummix run stt                   → only STT wrapper (Python)
 *   tsummix run worker                → only transcript worker HTTP server (Node)
 *   tsummix run dev [-d] [-o]         → docker compose (docker-compose.dev.yml); -o merges docker-compose.observe.yml (Prometheus + Grafana)
 *   tsummix run prod [-d] [-o]        → docker compose (docker-compose.prod.yml)
 *
 * Long flags: --distribute, --observe
 * Short flags: -d (distribute), -o (observe); can combine e.g. -do
 *
 * Expects .venv in repo root with uvicorn when starting Python, and Docker/Compose
 * installed when using dev/prod.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const sub = args[0]; // "run"
const rest = args.slice(1);
const target = rest.find((a) => !a.startsWith('-')); // undefined | "bot" | "stt" | "worker" | "dev" | "prod"

/**
 * Parses --distribute / -d / --observe / -o and combined short flags (-do).
 */
function parseRunFlags(argv) {
	let distribute = false;
	let observe = false;
	for (const a of argv) {
		if (a === '--distribute') {
			distribute = true;
			continue;
		}
		if (a === '--observe') {
			observe = true;
			continue;
		}
		if (a.startsWith('-') && a !== '-' && !a.startsWith('--')) {
			for (const ch of a.slice(1)) {
				if (ch === 'd') distribute = true;
				if (ch === 'o') observe = true;
			}
		}
	}
	return { distribute, observe };
}

const { distribute: hasDistributeFlag, observe: hasObserveFlag } = parseRunFlags(rest);
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
	// Run via launcher so cuda_env sets LD_LIBRARY_PATH before uvicorn starts (same fix as model_benchmark.py).
	const python = isWin
		? path.join(root, '.venv', 'Scripts', 'python.exe')
		: path.join(root, '.venv', 'bin', 'python3');
	const launcher = path.join(__dirname, 'run_stt_server.py');
	const child = spawn(python, [launcher], { cwd: root, stdio: 'inherit', shell: isWin });
	child.on('error', (err) => console.error(err));
	child.on('close', (code) => {
		if (code !== 0 && code !== null) process.exitCode = code;
	});
	return child;
}

function runWorker() {
	const child = spawn('node', ['services/transcript-worker/index.js'], {
		cwd: root,
		stdio: 'inherit',
		shell: isWin,
	});
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

function runDistribute() {
	// Worker HTTP server
	const workerProc = runWorker();
	// STT wrapper (Python)
	const sttProc = runSTT();
	// Bot, forced to use HTTP worker
	const botEnv = {
		...process.env,
		WORKER_USE_LOCAL: 'false',
		WORKER_BASE_URL: process.env.WORKER_BASE_URL || 'http://localhost:3000',
	};
	const botProc = spawn('node', ['index.js'], {
		cwd: root,
		stdio: 'inherit',
		shell: isWin,
		env: botEnv,
	});
	botProc.on('error', (err) => console.error(err));
	botProc.on('close', (code) => {
		if (code !== 0 && code !== null) process.exitCode = code;
	});

	process.on('SIGINT', () => {
		botProc.kill('SIGINT');
		workerProc.kill('SIGINT');
		sttProc.kill('SIGINT');
	});
}

/**
 * @param {string} file docker-compose file name
 * @param {boolean} distribute
 * @param {boolean} observe merge docker-compose.observe.yml (Prometheus + Grafana)
 */
function runCompose(file, distribute, observe) {
	const composeArgs = ['compose', '-f', file];
	if (observe) {
		composeArgs.push('-f', 'docker-compose.observe.yml');
	}
	composeArgs.push('up');

	if (observe && !distribute) {
		composeArgs.push('bot', 'stt-wrapper', 'prometheus', 'grafana');
	} else if (!observe && !distribute) {
		composeArgs.push('bot', 'stt-wrapper');
	}
	// distribute: no service list → start all services in merged compose

	const child = spawn('docker', composeArgs, {
		cwd: root,
		stdio: 'inherit',
		shell: isWin,
	});
	child.on('error', (err) => console.error(err));
	child.on('close', (code) => {
		if (code !== 0 && code !== null) process.exitCode = code;
	});
	return child;
}

if (sub !== 'run') {
	console.error('Usage: tsummix run [bot|stt|worker|dev|prod] [--distribute|-d] [--observe|-o]');
	process.exit(1);
}

if (hasObserveFlag && (!target || (target !== 'dev' && target !== 'prod'))) {
	console.warn(
		'tsummix: --observe (-o) only applies to "tsummix run dev" or "tsummix run prod" (Docker Compose). Ignored for local processes.',
	);
}

if (!target) {
	// tsummix run → local bot + STT wrapper
	if (hasDistributeFlag) {
		// tsummix run --distribute → local bot + worker + STT wrapper
		runDistribute();
	} else {
		runBoth();
	}
} else if (target === 'bot') {
	runBot();
} else if (target === 'stt') {
	runSTT();
} else if (target === 'worker') {
	runWorker();
} else if (target === 'dev') {
	runCompose('docker-compose.dev.yml', hasDistributeFlag, hasObserveFlag);
} else if (target === 'prod') {
	runCompose('docker-compose.prod.yml', hasDistributeFlag, hasObserveFlag);
} else {
	console.error('Usage: tsummix run [bot|stt|worker|dev|prod] [--distribute|-d] [--observe|-o]');
	process.exit(1);
}
