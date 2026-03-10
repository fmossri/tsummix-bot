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

function createTranscriptWorker({ sttBaseUrl, fetchImpl, fsImpl, pathImpl }) {
	const meetingsMap = new Map();

	async function writeTranscriptHeader(transcriptPath, { meetingId, channelId, meetingStartIso, participantDisplayNames }) {
		const header = {
			type: 'metadata',
			meetingId,
			channelId: channelId ?? null,
			meetingStartIso,
			participantDisplayNames: Array.isArray(participantDisplayNames) ? participantDisplayNames : [],
		};
		try {
			await fsImpl.promises.writeFile(transcriptPath, JSON.stringify(header) + '\n', 'utf8');
		} catch (error) {
			console.error('Error writing transcript header:', error);
			throw error;
		}
	}

	async function startTranscript(meetingId, meetingStartTimeMs) {
		try {
            if (typeof meetingStartTimeMs !== 'number') {
                meetingStartTimeMs = Date.now();
            }
			await fsImpl.promises.mkdir(pathImpl.join(__dirname, 'transcripts'), { recursive: true });
            const meetingStartTimeIso = new Date(meetingStartTimeMs).toISOString();
			const timestamp = meetingStartTimeIso.replace(/[:.]/g, '-');
			const transcriptPath = pathImpl.join(__dirname, 'transcripts', `${meetingId}_${timestamp}.jsonl`);
			const tempFilePath = pathImpl.join(__dirname, 'transcripts', `${meetingId}_${timestamp}.jsonl.tmp`);

			meetingsMap.set(meetingId, {
				chunksQueue: [],
				processedChunks: [],
				failedChunks: [],
				chunksBucket: new Map(),
				inFlight: false,
				meetingStartIso: meetingStartTimeIso,
				transcriptState: {
					filePath: transcriptPath,
					tmpPath: tempFilePath,
					processedSinceFlush: 0,
					processingPromise: null,
				},
			});
			return transcriptPath;
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
		try {
			if (typeof chunk.chunkId !== 'number') {
				throw new Error('Chunk ID must be a number');
			}
			if (!isValidWav(chunk.audio)) {
				throw new Error('Invalid WAV buffer; must be mono 16kHz PCM');
			}
			if (!chunk.participantData || typeof chunk.participantData !== 'object') {
				throw new Error('Chunk has no participantData');
			}
			chunk.participantId = chunk.participantData.participantId;
			chunk.displayName = chunk.participantData.displayName;
			chunk.segmentBuffer = [];
			chunk.retryCount = 0;
			meeting.chunksQueue.push(chunk);

			if (!meeting.transcriptState.processingPromise) {
				ensureProcessing(meetingId);
			}
		} catch (error) {
			console.error('Error enqueuing chunk:', error);
			throw error;
		}
	}

	async function appendToTemp(meetingId) {
		if (!meetingsMap.has(meetingId)) {
			throw new Error('Meeting not found');
		}
		const meeting = meetingsMap.get(meetingId);
		try {
			const tempPath = meeting.transcriptState.tmpPath;
			for (const chunk of meeting.processedChunks) {
				for (const segment of chunk.segmentBuffer) {
					const JSONLine = {
						meetingId: meetingId,
						chunkId: chunk.chunkId,
						participantId: chunk.participantId,
						displayName: chunk.displayName,
                        clockTimeMs: chunk.chunkClockTimeMs != null ?chunk.chunkClockTimeMs + (segment.startMs - chunk.chunkStartTimeMs) : null,
						startMs: segment.startMs,
						endMs: segment.endMs,
						text: segment.text,
					};
					await fsImpl.promises.appendFile(tempPath, JSON.stringify(JSONLine) + '\n');
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
				const audioBuffer = Buffer.from(chunk.audio).toString('base64');

				const response = await fetchImpl(postUrl, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						meetingId: meetingId,
						chunkId: chunk.chunkId,
						chunkStartTimeMs: chunk.chunkStartTimeMs,
						audio: audioBuffer,
					}),
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
					chunk.audio = null;
					meeting.processedChunks.push(chunk);
					meeting.transcriptState.processedSinceFlush++;
					meeting.chunksBucket.delete(responseJson.chunkId);
				}
				if (meeting.transcriptState.processedSinceFlush >= 5) {
					await appendToTemp(meetingId);
				}
			}
			if (meeting.processedChunks.length > 0) {
				await appendToTemp(meetingId);
			}
			meeting.inFlight = false;
		} catch (error) {
			console.error('Error processing next chunk:', error);
			throw error;
		}
	}

	async function closeTranscript(meetingId, { channelId, participantDisplayNames } = {}) {
		if (!meetingsMap.has(meetingId)) {
			throw new Error('Meeting not found');
		}
		const meeting = meetingsMap.get(meetingId);
		try {
			// Drain queue: process all remaining chunks and flush to tmp before building final transcript
			while (meeting.chunksQueue.length > 0 || meeting.transcriptState.processingPromise) {
				if (meeting.transcriptState.processingPromise) {
					await meeting.transcriptState.processingPromise;
				} else {
					ensureProcessing(meetingId);
					if (meeting.transcriptState.processingPromise) {
						await meeting.transcriptState.processingPromise;
					}
				}
			}
			// Flush any remaining processed chunks to tmp
			if (meeting.processedChunks.length > 0) {
				await appendToTemp(meetingId);
			}
			if (meeting.failedChunks.length > 0) {
				for (const chunk of meeting.failedChunks) {
					chunk.retryCount = 0;
					chunk.segmentBuffer = [];
					meeting.chunksQueue.push(chunk);
				}
				meeting.failedChunks = [];
				await ensureProcessing(meetingId);
				if (meeting.transcriptState.processingPromise) {
					await meeting.transcriptState.processingPromise;
				}
				if (meeting.processedChunks.length > 0) {
					await appendToTemp(meetingId);
				}
				if (meeting.failedChunks.length > 0) {
					const failedChunkStartTimes = meeting.failedChunks.map((chunk, i) => `chunk ${i}: ${chunk.chunkStartTimeMs}ms`).join(', ');
					console.error(`${meeting.failedChunks.length} chunks failed to transcribe: ${failedChunkStartTimes}`);
				}
			}
			const transcriptPath = meeting.transcriptState.filePath;
			const tmpPath = meeting.transcriptState.tmpPath;
			await writeTranscriptHeader(transcriptPath, {
				meetingId,
				channelId: channelId,
				meetingStartIso: meeting.meetingStartIso,
				participantDisplayNames: participantDisplayNames,
			});
			try {
				const segmentContent = await fsImpl.promises.readFile(tmpPath, 'utf8');
				await fsImpl.promises.appendFile(transcriptPath, segmentContent);
				await fsImpl.promises.unlink(tmpPath).catch(() => {});
			} catch (err) {
				if (err.code !== 'ENOENT') throw err;
			}
			meetingsMap.delete(meetingId);
			return transcriptPath;
		} catch (error) {
			throw new Error(error.message);
		}
	}

	return {
		startTranscript,
		enqueueChunk,
		closeTranscript,
	};
}

module.exports = { createTranscriptWorker };
