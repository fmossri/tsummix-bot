require('dotenv').config();

const { createTranscriptWorker } = require('./transcript-worker');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const app = express();
const { WORKER_PORT, STT_BASE_URL } = process.env;

if (!WORKER_PORT || !STT_BASE_URL) {
	console.error('Missing WORKER_PORT or STT_BASE_URL in .env');
	process.exit(1);
}

app.use(express.json());

const transcriptWorker = createTranscriptWorker({
	sttBaseUrl: STT_BASE_URL,
	fetchImpl: fetch,
	fsImpl: fs,
	pathImpl: path,
});

app.post('/start-transcript', async (req, res) => {
	try {
		const { transcriptId } = req.body;
		if (!transcriptId) return res.status(400).json({ error: 'Transcript ID is required' });
		const transcriptPath = await transcriptWorker.startTranscript(transcriptId);
		res.json({ started: true, transcriptPath });
	} catch (error) {
		console.error('Error starting transcript:', error);
		res.status(500).json({ error: error.message });
	}
});

app.post('/enqueue-chunk', async (req, res) => {
	try {
		const { transcriptId, chunk } = req.body;
		if (!transcriptId) return res.status(400).json({ error: 'Transcript ID is required' });
		if (!chunk) return res.status(400).json({ error: 'Chunk is required' });

		if (typeof chunk.audio === 'string') {
			chunk.audio = Buffer.from(chunk.audio, 'base64');
		}

		const result = await transcriptWorker.enqueueChunk(transcriptId, chunk);
		res.json(result);
	} catch (error) {
		console.error('Error enqueuing chunk:', error);
		res.status(500).json({ error: error.message });
	}
});

app.post('/close-transcript', async (req, res) => {
	try {
		const { transcriptId, channelId, participantDisplayNames } = req.body;
		if (!transcriptId) return res.status(400).json({ error: 'Transcript ID is required' });
		const transcriptPath = await transcriptWorker.closeTranscript(transcriptId, {
			channelId: channelId ?? undefined,
			participantDisplayNames: participantDisplayNames ?? undefined,
		});
		res.json({ transcriptPath });
	} catch (error) {
		console.error('Error closing transcript:', error);
		res.status(500).json({ error: error.message });
	}
});

app.listen(WORKER_PORT, () => {
	console.log(`Worker started on port ${WORKER_PORT}`);
});
