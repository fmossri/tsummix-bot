const wav = require('node-wav');
const logger = require('../logger/logger');
const appMetrics = require('../metrics/metrics');

const WAV_SAMPLE_RATE = 16000;
const COMPONENT = 'transcript-worker';
const WAV_CHANNELS = 1;
const MAX_RETRIES = 3;

function isValidWav(audioBuffer) {
	try {
		const result = wav.decode(audioBuffer);
		if (result.sampleRate !== WAV_SAMPLE_RATE || result.channelData.length !== WAV_CHANNELS) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

function createTranscriptWorker({ sttBaseUrl, fetchImpl, fsImpl, pathImpl }) {
	const transcriptsMap = new Map();

	function getTotalQueueDepth() {
		let sum = 0;
		for (const t of transcriptsMap.values()) sum += t.chunksQueue.length;
		return sum;
	}

	async function writeTranscriptHeader(transcriptPath, { transcriptId, channelId, meetingStartIso, participantDisplayNames }) {
		const header = {
			type: 'metadata',
			transcriptId,
			channelId: channelId ?? null,
			meetingStartIso,
			participantDisplayNames: Array.isArray(participantDisplayNames) ? participantDisplayNames : [],
		};
		try {
			await fsImpl.promises.writeFile(transcriptPath, JSON.stringify(header) + '\n', 'utf8');
		} catch (error) {
			throw error;
		}
	}

	async function startTranscript(transcriptId, meetingStartTimeMs) {
		try {
            if (typeof meetingStartTimeMs !== 'number') {
                meetingStartTimeMs = Date.now();
            }
			await fsImpl.promises.mkdir(pathImpl.join(__dirname, 'transcripts'), { recursive: true });
            const meetingStartTimeIso = new Date(meetingStartTimeMs).toISOString();
			const timestamp = meetingStartTimeIso.replace(/[:.]/g, '-');
			const transcriptPath = pathImpl.join(__dirname, 'transcripts', `${transcriptId}_${timestamp}.jsonl`);
			const tempFilePath = pathImpl.join(__dirname, 'transcripts', `${transcriptId}_${timestamp}.jsonl.tmp`);

			transcriptsMap.set(transcriptId, {
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
			logger.info(COMPONENT, 'transcript_started', 'Transcript started', {
				transcriptId,
				meetingStartIso: meetingStartTimeIso,
				filePath: transcriptPath,
			});
			return transcriptPath;
		} catch (error) {
			logger.error(COMPONENT, 'transcript_start_failed', 'Failed to start transcript', {
				transcriptId,
				errorClass: error.constructor?.name || 'Error',
				message: error.message,
			});
			throw error;
		}
	}

	function ensureProcessing(transcriptId) {
		if (!transcriptsMap.has(transcriptId)) {
			throw new Error('Transcript not found');
		}
		const transcript = transcriptsMap.get(transcriptId);
		if (!transcript.transcriptState.processingPromise) {
			transcript.transcriptState.processingPromise = processNextChunk(transcriptId)
				.finally(() => {
					transcript.transcriptState.processingPromise = null;
				});
		}
		return transcript.transcriptState.processingPromise;
	}

	async function enqueueChunk(transcriptId, chunk) {
		if (!transcriptsMap.has(transcriptId)) {
			throw new Error('Transcript not found');
		}
		const transcript = transcriptsMap.get(transcriptId);
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
			chunk.receivedAtMs = Date.now();
			transcript.chunksQueue.push(chunk);
			appMetrics.increment('chunks_enqueued_total');
			appMetrics.set('worker_queue_depth', getTotalQueueDepth());

			logger.debug(COMPONENT, 'chunk_enqueued', 'Chunk enqueued', {
				transcriptId,
				chunkId: chunk.chunkId,
				queueDepth: transcript.chunksQueue.length,
			});

			if (!transcript.transcriptState.processingPromise) {
				ensureProcessing(transcriptId);
			}
		} catch (error) {
			appMetrics.increment('chunk_enqueue_validation_failures_total');
			logger.error(COMPONENT, 'chunk_enqueue_failed', 'Chunk validation or enqueue failed', {
				transcriptId,
				chunkId: chunk?.chunkId,
				errorClass: error.constructor?.name || 'Error',
				message: error.message,
			});
			throw error;
		}
	}

	async function appendToTemp(transcriptId) {
		if (!transcriptsMap.has(transcriptId)) {
			throw new Error('Transcript not found');
		}
		const transcript = transcriptsMap.get(transcriptId);
		try {
			const tempPath = transcript.transcriptState.tmpPath;
			for (const chunk of transcript.processedChunks) {
				for (const segment of chunk.segmentBuffer) {
					const JSONLine = {
						transcriptId: transcriptId,
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
			transcript.processedChunks = [];
			transcript.transcriptState.processedSinceFlush = 0;
		} catch (error) {
			appMetrics.increment('transcript_flush_failures_total');
			logger.error(COMPONENT, 'flush_failed', 'Failed to write transcript segments to file', {
				transcriptId,
				errorClass: error.constructor?.name || 'Error',
				message: error.message,
			});
			throw error;
		}
	}

	async function processNextChunk(transcriptId) {
		let inSttAttempt = false;
		let countedCall = false;
		try {
			if (!transcriptsMap.has(transcriptId)) {
				throw new Error('Transcript not found');
			}
			const transcript = transcriptsMap.get(transcriptId);
			if (transcript.chunksQueue.length === 0) {
				transcript.inFlight = false;
				return;
			}
			transcript.inFlight = true;
			const postUrl = sttBaseUrl + '/transcribe';

			while (transcript.chunksQueue.length > 0) {
				inSttAttempt = true;
				countedCall = false;
				const chunk = transcript.chunksQueue.shift();
				appMetrics.set('worker_queue_depth', getTotalQueueDepth());
				transcript.chunksBucket.set(chunk.chunkId, chunk);
				const queueWaitMs = chunk.receivedAtMs != null ? Date.now() - chunk.receivedAtMs : null;
				const audioBuffer = Buffer.from(chunk.audio).toString('base64');
				const sttStartMs = Date.now();

				const response = await fetchImpl(postUrl, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						transcriptId: transcriptId,
						chunkId: chunk.chunkId,
						chunkStartTimeMs: chunk.chunkStartTimeMs,
						audio: audioBuffer,
					}),
				});

				appMetrics.increment('stt_calls_total');
				countedCall = true;

				if (response.status !== 200) {
					chunk.retryCount++;
					if (chunk.retryCount < MAX_RETRIES) {
						transcript.chunksQueue.unshift(chunk);
						transcript.chunksBucket.delete(chunk.chunkId);
						break;
					} else {
						appMetrics.increment('stt_errors_total');
						appMetrics.observe('stt_latency_ms', Date.now() - sttStartMs);
						if (queueWaitMs != null) appMetrics.observe('stt_queue_wait_ms', queueWaitMs);
						appMetrics.increment('chunks_failed_total');
						logger.error(COMPONENT, 'stt_response_failed', 'STT failed after retries', {
							transcriptId,
							chunkId: chunk.chunkId,
							statusCode: response.status,
							retryCount: chunk.retryCount,
							errorClass: 'STTNon200',
							message: response.statusText || 'STT request failed',
							queueWaitMs,
						});
						transcript.chunksBucket.delete(chunk.chunkId);
						transcript.failedChunks.push(chunk);
						continue;
					}
				}

				const responseJson = await response.json();
				const latencyMs = Date.now() - sttStartMs;
				appMetrics.observe('stt_latency_ms', latencyMs);
				if (queueWaitMs != null) appMetrics.observe('stt_queue_wait_ms', queueWaitMs);
				const segments = responseJson.segments || [];
				const responseMetrics = responseJson.metrics || {};
				logger.info(COMPONENT, 'stt_response_ok', 'STT succeeded', {
					transcriptId,
					chunkId: chunk.chunkId,
					latencyMs,
					queueWaitMs,
					realTimeFactor: responseMetrics.realTimeFactor ?? null,
					segmentsCount: segments.length,
				});

				if (transcript.chunksBucket.has(responseJson.chunkId)) {
					const bucketChunk = transcript.chunksBucket.get(responseJson.chunkId);
					bucketChunk.segmentBuffer.push(...responseJson.segments);
					bucketChunk.audio = null;
					transcript.processedChunks.push(bucketChunk);
					transcript.transcriptState.processedSinceFlush++;
					transcript.chunksBucket.delete(responseJson.chunkId);
				}
				if (transcript.transcriptState.processedSinceFlush >= 5) {
					await appendToTemp(transcriptId);
				}
			}
			if (transcript.processedChunks.length > 0) {
				await appendToTemp(transcriptId);
			}
			transcript.inFlight = false;
		} catch (error) {
			if (inSttAttempt && !countedCall) {
				appMetrics.increment('stt_calls_total');
			}
			appMetrics.increment('stt_errors_total');
			logger.error(COMPONENT, 'stt_response_failed', 'STT request failed', {
				transcriptId,
				errorClass: error.constructor?.name || 'Error',
				message: error.message,
			});
			throw error;
		}
	}

	async function closeTranscript(transcriptId, { channelId, participantDisplayNames } = {}) {
		if (!transcriptsMap.has(transcriptId)) {
			throw new Error('Transcript not found');
		}
		const transcript = transcriptsMap.get(transcriptId);
		try {
			// Drain queue: process all remaining chunks and flush to tmp before building final transcript
			while (transcript.chunksQueue.length > 0 || transcript.transcriptState.processingPromise) {
				if (transcript.transcriptState.processingPromise) {
					await transcript.transcriptState.processingPromise;
				} else {
					ensureProcessing(transcriptId);
					if (transcript.transcriptState.processingPromise) {
						await transcript.transcriptState.processingPromise;
					}
				}
			}
			// Flush any remaining processed chunks to tmp
			if (transcript.processedChunks.length > 0) {
				await appendToTemp(transcriptId);
			}
			if (transcript.failedChunks.length > 0) {
				for (const chunk of transcript.failedChunks) {
					chunk.retryCount = 0;
					chunk.segmentBuffer = [];
					transcript.chunksQueue.push(chunk);
				}
				transcript.failedChunks = [];
				await ensureProcessing(transcriptId);
				if (transcript.transcriptState.processingPromise) {
					await transcript.transcriptState.processingPromise;
				}
				if (transcript.processedChunks.length > 0) {
					await appendToTemp(transcriptId);
				}
				if (transcript.failedChunks.length > 0) {
					const failedChunkStartTimes = transcript.failedChunks.map((chunk, i) => `chunk ${i}: ${chunk.chunkStartTimeMs}ms`).join(', ');
					console.error(`${transcript.failedChunks.length} chunks failed to transcribe: ${failedChunkStartTimes}`);
				}
			}
			const transcriptPath = transcript.transcriptState.filePath;
			const tmpPath = transcript.transcriptState.tmpPath;
			await writeTranscriptHeader(transcriptPath, {
				transcriptId,
				channelId: channelId,
				meetingStartIso: transcript.meetingStartIso,
				participantDisplayNames: participantDisplayNames,
			});
			try {
				const segmentContent = await fsImpl.promises.readFile(tmpPath, 'utf8');
				await fsImpl.promises.appendFile(transcriptPath, segmentContent);
				await fsImpl.promises.unlink(tmpPath).catch(() => {});
			} catch (err) {
				if (err.code !== 'ENOENT') throw err;
			}
			transcriptsMap.delete(transcriptId);
			logger.info(COMPONENT, 'transcript_closed', 'Transcript closed', {
				transcriptId,
				channelId: channelId ?? null,
				filePath: transcriptPath,
			});
			return transcriptPath;
		} catch (error) {
			logger.error(COMPONENT, 'transcript_close_failed', 'Failed to close transcript', {
				transcriptId,
				errorClass: error.constructor?.name || 'Error',
				message: error.message,
			});
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
