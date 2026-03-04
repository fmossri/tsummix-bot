const wav = require('node-wav');


const WAV_SAMPLE_RATE = 16000;
const WAV_CHANNELS = 1;
const MAX_RETRIES = 3;

function isValidWav(audioBuffer) {
    try {
        const result = wav.decode(audioBuffer);
        if (result.sampleRate !== WAV_SAMPLE_RATE || result.channelData.length !== WAV_CHANNELS) {
            return false;
        }
        return true;
    } catch (error) {
        console.error('Error decoding WAV buffer:', error);
        return false;
    }
}

function createTranscriptWorker({sttBaseUrl, fetchImpl, fsImpl, pathImpl}) {
    const meetingsMap = new Map();

    async function startMeeting(meetingId) {
        try {
            await fsImpl.promises.mkdir(pathImpl.join(__dirname, 'transcripts'), { recursive: true });
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const transcriptPath = pathImpl.join(__dirname, 'transcripts', `${meetingId}_${timestamp}.jsonl`);
            meetingsMap.set(meetingId, {
                chunksQueue: [],
                processedChunks: [],
                failedChunks: [],
                chunksBucket: new Map(),
                inFlight: false,
                transcriptState: {
                    filePath: transcriptPath,
                    closed: false,
                    processedSinceFlush: 0,
                    processingPromise: null,
                }
            });
            return { transcriptPath };
        } catch (error) {
            console.error('Error starting meeting:', error);
            throw error;
        }
    }

    function ensureProcessing(meetingId) {
        if (!meetingsMap.has(meetingId)) {
            throw new Error('Meeting not found');
        }
        const meeting = meetingsMap.get(meetingId);
        if (!meeting.transcriptState.processingPromise) {
            meeting.transcriptState.processingPromise = processNextChunk(meetingId)
            .finally(() => {
                meeting.transcriptState.processingPromise = null;
            });
        }
        return meeting.transcriptState.processingPromise;
    }

    async function enqueueChunk(meetingId, chunk) {
        if (!meetingsMap.has(meetingId)) {
            throw new Error('Meeting not found');
        }
        const meeting = meetingsMap.get(meetingId);
        if (meeting.transcriptState.closed) {
            throw new Error('Meeting is closed');
        }
        try {
            if (typeof chunk.chunkId !== 'number') {
                throw new Error('Chunk ID must be a number');
            }
            if (chunk.chunkStartTimeMs >= chunk.chunkEndTimeMs) {
                throw new Error('Chunk start time must be before end time');
            }
            if (!isValidWav(chunk.audio)) {
                throw new Error('Invalid WAV buffer; must be mono 16kHz PCM');
            }
            chunk = {
                chunkId: chunk.chunkId,
                participantId: chunk.participantId,
                displayName: chunk.displayName,
                chunkStartTimeMs: chunk.chunkStartTimeMs,
                chunkEndTimeMs: chunk.chunkEndTimeMs,
                audioBytes: chunk.audio,
                segmentBuffer: [],
                retryCount: 0,
            };
            meeting.chunksQueue.push(chunk);

            if (!meeting.transcriptState.processingPromise) {
                ensureProcessing(meetingId);
            }
        } catch (error) {
            console.error('Error enqueuing chunk:', error);
            throw error;
        }
    }

    async function writeTranscriptFile(meetingId) {
        if (!meetingsMap.has(meetingId)) {
            throw new Error('Meeting not found');
        }
        const meeting = meetingsMap.get(meetingId);
        try {
            const transcriptPath = meeting.transcriptState.filePath;
            for (const chunk of meeting.processedChunks) {
                for (const segment of chunk.segmentBuffer) {
                    const JSONLine = {
                        meetingId: meetingId,
                        chunkId: chunk.chunkId,
                        participantId: chunk.participantId,
                        displayName: chunk.displayName,
                        startMs: segment.startMs,
                        endMs: segment.endMs,
                        text: segment.text,
                        };
                        await fsImpl.promises.appendFile(transcriptPath, JSON.stringify(JSONLine) + '\n');
                    } 
            }
            meeting.processedChunks = [];
            meeting.transcriptState.processedSinceFlush = 0;
        } catch (error) {
            console.error('Error writing transcript file:', error);
            throw error;
        }
    }

    async function processNextChunk(meetingId) {
        try {
            if (!meetingsMap.has(meetingId)) {
                throw new Error('Meeting not found');
            }
            const meeting = meetingsMap.get(meetingId);
            if (meeting.chunksQueue.length === 0) {
                meeting.inFlight = false;
                return;
            }
            meeting.inFlight = true;
            const postUrl = sttBaseUrl + '/transcribe';

            while (meeting.chunksQueue.length > 0) {
                const chunk = meeting.chunksQueue.shift();
                meeting.chunksBucket.set(chunk.chunkId, chunk);
                const audioBuffer = Buffer.from(chunk.audioBytes).toString('base64');

                const response = await fetchImpl(postUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        meetingId: meetingId,
                        chunkId: chunk.chunkId,
                        chunkStartTimeMs: chunk.chunkStartTimeMs,
                        chunkEndTimeMs: chunk.chunkEndTimeMs,
                        audio: audioBuffer,
                    })
                });

                if (response.status !== 200) {
                    console.error('Failed to transcribe chunk. Retrying:', response.status, response.statusText);
                    chunk.retryCount++;
                    if (chunk.retryCount < MAX_RETRIES) {
                        meeting.chunksQueue.unshift(chunk);
                        meeting.chunksBucket.delete(chunk.chunkId);
                        break;
                    } else {
                        console.error('Failed to transcribe chunk after ' + MAX_RETRIES + ' retries');
                        meeting.chunksBucket.delete(chunk.chunkId);
                        meeting.failedChunks.push(chunk);
                        continue;
                    }
                }

                const responseJson = await response.json();
                if (meeting.chunksBucket.has(responseJson.chunkId)) {
                    const chunk = meeting.chunksBucket.get(responseJson.chunkId);
                    chunk.segmentBuffer.push(...responseJson.segments);
                    chunk.audioBytes = null;
                    meeting.processedChunks.push(chunk);
                    meeting.transcriptState.processedSinceFlush++;
                    meeting.chunksBucket.delete(responseJson.chunkId);
                }
                if (meeting.transcriptState.processedSinceFlush >= 5) {
                    await writeTranscriptFile(meetingId);
                }
            }
            if (meeting.processedChunks.length > 0) {
                await writeTranscriptFile(meetingId);
            }
            meeting.inFlight = false;
        } catch (error) {
            console.error('Error processing next chunk:', error);
            throw error;
        }
    }

    async function closeMeeting(meetingId) {
        if (!meetingsMap.has(meetingId)) {
            throw new Error('Meeting not found');
        }
        const meeting = meetingsMap.get(meetingId);
        meeting.transcriptState.closed = true;
        try {
            if (meeting.transcriptState.processingPromise) {
                await meeting.transcriptState.processingPromise;
            }
            if (meeting.failedChunks.length > 0) {
                for (const chunk of meeting.failedChunks) {
                    chunk.retryCount = 0;
                    chunk.segmentBuffer = [];
                    meeting.chunksQueue.push(chunk);
                }
                meeting.failedChunks = [];
                await ensureProcessing(meetingId);

                if (meeting.failedChunks.length > 0) {
                    const failedChunkStartTimes = meeting.failedChunks.map((chunk, i) => `chunk ${i}: ${chunk.chunkStartTimeMs}ms`).join(', ');
                    console.error(`${meeting.failedChunks.length} chunks failed to transcribe: ${failedChunkStartTimes}`);
                }
            }	
            return meeting.transcriptState.filePath;
        } catch (error) {
            console.error('Error closing meeting:', error);
            throw error;
        } finally {
            meetingsMap.delete(meetingId);
        }
    }
    return {
        startMeeting,
        enqueueChunk,
        closeMeeting,
    };
}

module.exports = { createTranscriptWorker };