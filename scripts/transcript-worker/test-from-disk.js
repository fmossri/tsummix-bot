/**
 * Smoke test for the transcript worker: reads WAV files from a directory
 * (e.g. tests/audio-samples or tests/audio-files), starts a meeting, enqueues
 * each file as a chunk, closes the meeting, then prints the transcript path
 * and a short preview of the JSONL output.
 *
 * Prerequisites: STT wrapper running (e.g. uvicorn stt-wrapper.app:app).
 * Usage (from repo root): node scripts/transcript-worker/test-from-disk.js [audio-dir]
 * Default audio-dir: tests/audio-samples
 */

require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');

const scriptDir = __dirname;
const repoRoot = path.join(scriptDir, '..', '..');
const workerPath = path.join(repoRoot, 'services', 'worker', 'transcript-worker.js');
const { createTranscriptWorker } = require(workerPath);

const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');

const audioDir = process.argv[2] || path.join(process.cwd(), 'tests', 'audio-samples');
const meetingId = 'test-meeting-from-disk';
const participantId = 'test-participant';
const displayName = 'Test User';

async function main() {
    const sttBaseUrl = process.env.STT_BASE_URL;
    if (!sttBaseUrl) {
        console.error('STT_BASE_URL must be set in .env (e.g. http://localhost:8000)');
        process.exit(1);
    }

    if (!fs.existsSync(audioDir)) {
        console.error('Audio directory not found:', audioDir);
        process.exit(1);
    }

    const files = fs.readdirSync(audioDir)
        .filter((f) => f.toLowerCase().endsWith('.wav'))
        .sort();

    if (files.length === 0) {
        console.error('No .wav files in', audioDir);
        process.exit(1);
    }

    const transcriptWorker = createTranscriptWorker({
        sttBaseUrl,
        fetchImpl: fetch,
        fsImpl: fs,
        pathImpl: path,
    });

    console.log('Starting meeting:', meetingId);
    const { transcriptPath } = await transcriptWorker.startMeeting(meetingId);
    console.log('Transcript will be written to:', transcriptPath);

    let chunkId = 0;
    const chunkDurationMs = 30000;
    for (const file of files) {
        const filePath = path.join(audioDir, file);
        const audio = fs.readFileSync(filePath);
        const startMs = chunkId * chunkDurationMs;
        const endMs = startMs + chunkDurationMs;
        await transcriptWorker.enqueueChunk(meetingId, {
            chunkId,
            participantId,
            displayName,
            chunkStartTimeMs: startMs,
            chunkEndTimeMs: endMs,
            audio,
        });
        console.log('Enqueued chunk', chunkId, file);
        chunkId += 1;
    }

    console.log('Closing meeting...');
    const finalPath = await transcriptWorker.closeMeeting(meetingId);
    console.log('Meeting closed. Transcript file:', finalPath);

    if (fs.existsSync(finalPath)) {
        const content = fs.readFileSync(finalPath, 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);
        console.log('Lines in transcript:', lines.length);
        if (lines.length > 0) {
            console.log('First line(s):');
            lines.slice(0, 3).forEach((line, i) => console.log(' ', i + 1, line));
        }
    } else {
        console.log('(Transcript file not found at', finalPath, ')');
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
