const { workerConfig } = require('../../config/index.js');
const { createTranscriptWorker } = require('./transcript-worker');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const app = express();

app.use(express.json());

const transcriptWorker = createTranscriptWorker({
	workerConfig,
	fetchImpl: fetch,
	fsImpl: fs,
	pathImpl: path,
});

app.post('/start-transcript', async (req, res) => {
	try {
		const { transcriptId, meetingStartTimeMs } = req.body;
		if (!transcriptId) return res.status(400).json({ error: 'Transcript ID is required' });
		const transcriptPath = await transcriptWorker.startTranscript(transcriptId, meetingStartTimeMs);
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

		await transcriptWorker.enqueueChunk(transcriptId, chunk);
		res.json({ok: true});
	} catch (error) {
		console.error('Error enqueuing chunk:', error);
		res.status(500).json({ error: error.message });
	}
});

app.post('/close-transcript', async (req, res) => {
	try {
		const { transcriptId, channelId, participantDisplayNames, closure } = req.body;
		if (!transcriptId) return res.status(400).json({ error: 'Transcript ID is required' });
		await transcriptWorker.closeTranscript(transcriptId, {
			channelId: channelId ?? undefined,
			participantDisplayNames: participantDisplayNames ?? undefined,
			closure: closure ?? undefined,
		});
		res.json({ ok: true });
	} catch (error) {
		console.error('Error closing transcript:', error);
		res.status(500).json({ error: error.message });
	}
});

app.listen(workerConfig.workerPort, () => {
	console.log(`Worker started on port ${workerConfig.workerPort}`);
});
