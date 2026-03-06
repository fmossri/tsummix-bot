require('dotenv').config();

const { createTranscriptWorker } = require('./transcript-worker');
const fetch = require('node-fetch');
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

app.post('/start-meeting', async (req, res) => {
    try {
        const { meetingId, channelId, participantDisplayNames } = req.body;
        if (!meetingId) return res.status(400).json({ error: 'Meeting ID is required' });
        const metadata = {};
        if (channelId != null) metadata.channelId = channelId;
        if (participantDisplayNames != null) metadata.participantDisplayNames = participantDisplayNames;
        const result = await transcriptWorker.startMeeting(meetingId, metadata);
        res.json(result);
    } catch (error) {
        console.error('Error starting meeting:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/enqueue-chunk', async (req, res) => {
    try {
        const { meetingId, chunk } = req.body;
        if (!meetingId) return res.status(400).json({ error: 'Meeting ID is required' });
        if (!chunk) return res.status(400).json({ error: 'Chunk is required' });

        if (typeof chunk.audio === 'string') {
            chunk.audio = Buffer.from(chunk.audio, 'base64');
        }

        const result = await transcriptWorker.enqueueChunk(meetingId, chunk);
        res.json(result);
    } catch (error) {
        console.error('Error enqueuing chunk:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/close-meeting', async (req, res) => {
    try {
        const { meetingId } = req.body;
        if (!meetingId) return res.status(400).json({ error: 'Meeting ID is required' });
        const result = await transcriptWorker.closeMeeting(meetingId);
        res.json({ transcriptPath: result });
    } catch (error) {
        console.error('Error closing meeting:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(WORKER_PORT, () => {
    console.log(`Worker started on port ${WORKER_PORT}`);
});
