const logger = require('../logger/logger');
const appMetrics = require('../metrics/metrics');
const { isValidWav } = require('../../utils/is-valid-wav.js');

const COMPONENT = 'transcript-worker';

function createTranscriptWorker({ workerConfig, fetchImpl, fsImpl, pathImpl }) {

    const { maxRetries: MAX_RETRIES, flushAfterProcessedChunks: FLUSH_AFTER_PROCESSED_CHUNKS } = workerConfig;
	const { sttBaseUrl, workerTimeouts, sttAuthToken } = workerConfig;
	const transcriptsDir = workerConfig.transcriptsDir || pathImpl.join(__dirname, 'transcripts');
	const transcriptsMap = new Map();
	let sttReadyWaited = false;

    function getSttHeaders(sttAuthToken) {
        const headers = { 'Content-Type': 'application/json' };
        if (sttAuthToken) {
            headers['internal-stt-auth'] = sttAuthToken;
        }
        return headers;
    }



	function getTotalQueueDepth() {
		let sum = 0;
		for (const t of transcriptsMap.values()) sum += t.chunksQueue.length;
		return sum;
	}

	async function writeTranscriptHeader(transcriptPath, { transcriptId, channelId, meetingStartIso, participantDisplayNames, closure }) {
		const header = {
			type: 'metadata',
			transcriptId,
			channelId: channelId ?? null,
			meetingStartIso,
			participantDisplayNames: Array.isArray(participantDisplayNames) ? participantDisplayNames : [],
			closure: closure && typeof closure === 'object' ? closure : null,
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
			await fsImpl.promises.mkdir(transcriptsDir, { recursive: true });
            const meetingStartTimeIso = new Date(meetingStartTimeMs).toISOString();
			const timestamp = meetingStartTimeIso.replace(/[:.]/g, '-');
			const transcriptPath = pathImpl.join(transcriptsDir, `${transcriptId}_${timestamp}.jsonl`);
			const tempFilePath = pathImpl.join(transcriptsDir, `${transcriptId}_${timestamp}.jsonl.tmp`);

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
				errorClass: 'TranscriptStartFailed',
				innerErrorClass: error.constructor?.name || 'Error',
				message: error.message,
			});
			throw error;
		}
	}

	function ensureProcessing(transcriptId) {
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
        let transcript;
        try {
            if (!transcriptsMap.has(transcriptId)) {
                throw new Error('Invariant: transcript not found in enqueueChunk');
            }

            transcript = transcriptsMap.get(transcriptId);
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

			logger.info(COMPONENT, 'chunk_enqueued', 'Chunk enqueued', {
				transcriptId,
				chunkId: chunk.chunkId,
				workerQueueDepth: transcript.chunksQueue.length,
			});

		} catch (error) {
			appMetrics.increment('chunk_enqueue_validation_failures_total');
			logger.error(COMPONENT, 'chunk_enqueue_failed', 'Chunk validation failed', {
				transcriptId,
				chunkId: chunk?.chunkId,
				errorClass: 'InvalidChunk',
				innerErrorClass: error.constructor?.name || 'Error',
				message: error.message,
			});
			throw error;
		}
        if (!transcript.transcriptState.processingPromise) ensureProcessing(transcriptId);
	}

	function getSegmentClockTimeMs(chunk, segment) {
		return chunk.chunkClockTimeMs != null && typeof chunk.chunkStartTimeMs === 'number'
			? chunk.chunkClockTimeMs + (segment.startMs - chunk.chunkStartTimeMs)
			: null;
	}

	function formatGapText({ chunkId, retryCount, reason }) {
		const reasonText = reason ? ` (${reason})` : '';
		return `**Missing transcript for chunk ${chunkId} after ${retryCount} attempts${reasonText}.**`;
	}

    function addGapMarkers(transcriptId, missingChunkIds) {
        const transcriptState = transcriptsMap.get(transcriptId);
        let chunksList; 
        if (missingChunkIds?.length > 0) {
            chunksList = missingChunkIds.map((chunkId) => ({
                chunkId: chunkId, 
                text: `Chunk ${chunkId} never reached the worker queue`,
            }));

        } else {
            chunksList = transcriptState.failedChunks

        }
        for (const chunk of chunksList) {
            const clockTimeMs =
                typeof chunk.chunkClockTimeMs === 'number'
                    ? chunk.chunkClockTimeMs
                    : null;
            transcriptState.processedChunks.push({
                type: 'gap',
                chunkId: chunk.chunkId,
                participantId: chunk.participantId ?? null,
                displayName: chunk.displayName ?? 'System',
                clockTimeMs,
                retryCount: chunk.retryCount ?? null,
                reason: chunk.lastErrorClass ?? null,
                text: chunk.text ?? formatGapText({
                    chunkId: chunk.chunkId,
                    retryCount: chunk.retryCount ?? MAX_RETRIES,
                    reason: chunk.lastErrorClass ?? null,
                }),
            });
        }
    }

	async function appendToTemp(transcriptId) {
		if (!transcriptsMap.has(transcriptId)) {
			throw new Error('Invariant: transcript not found in appendToTemp');
		}
		const transcript = transcriptsMap.get(transcriptId);
		if (transcript.processedChunks.length === 0) return;

		const lines = [];
		for (const chunk of transcript.processedChunks) {
			if (chunk.type === 'gap') {
				const JSONLine = {
					type: 'gap',
					transcriptId: transcriptId,
					chunkId: chunk.chunkId,
					participantId: chunk.participantId ?? null,
					displayName: chunk.displayName,
					clockTimeMs: typeof chunk.clockTimeMs === 'number' ? chunk.clockTimeMs : null,
					startMs: null,
					endMs: null,
					text: chunk.text,
					retryCount: typeof chunk.retryCount === 'number' ? chunk.retryCount : null,
					reason: chunk.reason ?? null,
				};
				lines.push(JSON.stringify(JSONLine) + '\n');
				continue;
			}

			// Within a chunk: if we can compute clockTimeMs for all segments, order by it; else leave internal order intact.
			const hasTimestamp = chunk.chunkClockTimeMs != null && typeof chunk.chunkStartTimeMs === 'number';
			const segments = hasTimestamp
				? [...chunk.segmentBuffer].sort((s1, s2) => getSegmentClockTimeMs(chunk, s1) - getSegmentClockTimeMs(chunk, s2))
				: chunk.segmentBuffer;

			for (const segment of segments) {
				const JSONLine = {
                    type: 'segment',
					transcriptId: transcriptId,
					chunkId: chunk.chunkId,
					participantId: chunk.participantId,
					displayName: chunk.displayName,
					clockTimeMs: getSegmentClockTimeMs(chunk, segment),
					startMs: segment.startMs,
					endMs: segment.endMs,
					text: segment.text,
				};
				lines.push(JSON.stringify(JSONLine) + '\n');
			}
		}
		const content = lines.join('');

		try {
			await fsImpl.promises.appendFile(transcript.transcriptState.tmpPath, content);
			transcript.processedChunks = [];
			transcript.transcriptState.processedSinceFlush = 0;
		} catch (error) {
			appMetrics.increment('transcript_flush_failures_total');
			logger.error(COMPONENT, 'flush_failed', 'Failed to write transcript segments to file', {
				transcriptId,
				errorClass: 'TranscriptFlushFailed',
				innerErrorClass: error.constructor?.name || 'Error',
				message: error.message,
			});
			// Do not throw: keep processedChunks for next flush attempt (opportunistic retry).
			// Meeting capture and STT processing continue; next successful batch will retry this backlog.
		}
	}

	function recordChunkFailure(transcriptId, chunk, logContext) {
		const transcript = transcriptsMap.get(transcriptId);
        transcript.chunksBucket.delete(chunk.chunkId);
		chunk.lastErrorClass = logContext?.errorClass ?? null;
		chunk.lastErrorMessage = logContext?.message ?? null;
		appMetrics.increment('chunks_failed_total');
		logger.error(COMPONENT, 'stt_response_failed', 'STT failed after retries', {
			transcriptId,
			chunkId: chunk.chunkId,
			errorClass: logContext?.errorClass ?? 'SttNon200',
			...logContext,
		});
		transcript.failedChunks.push(chunk);
	}

	function fetchWithTimeout(url, options, timeoutMs) {
		const controller = new AbortController();
		const id = setTimeout(() => controller.abort(), timeoutMs);

		return fetchImpl(url, {
			...options,
			signal: controller.signal,
		})
			.catch((error) => {
				if (error.name === 'AbortError' || error.constructor?.name === 'AbortError') {
					error.isSttTimeout = true;
				}
				throw error;
			})
			.finally(() => {
				clearTimeout(id);
			});
	}

    async function waitForSttReady() {
		const deadline = Date.now() + workerTimeouts.sttReadyTimeoutMs;
		const healthUrl = sttBaseUrl.replace(/\/$/, '') + '/health';
		while (Date.now() < deadline) {
			try {
				const res = await fetchImpl(healthUrl, { 
                    headers: getSttHeaders(sttAuthToken),
                    signal: AbortSignal.timeout(1000),
                });
                if (res.status === 200) {
                    const body = await res.json();
                    if (body && body.ready === true) return;
                }
			} catch (_) { /* ignore */ }
			await new Promise((r) => setTimeout(r, workerTimeouts.sttReadyPollMs));
		}
		throw new Error(`STT wrapper not ready within ${workerTimeouts.sttReadyTimeoutMs}ms`);
	}

	async function processNextChunk(transcriptId) {
		if (!transcriptsMap.has(transcriptId)) {
			throw new Error('Invariant: transcript not found in processNextChunk');
		}
		const transcript = transcriptsMap.get(transcriptId);
		if (transcript.chunksQueue.length === 0) {
			transcript.inFlight = false;
		return;
		}
		transcript.inFlight = true;
        const postUrl = sttBaseUrl + '/transcribe';

        try {
			while (transcript.chunksQueue.length > 0) {
                await waitForSttReady();
				const chunk = transcript.chunksQueue.shift();
				appMetrics.set('worker_queue_depth', getTotalQueueDepth());
				transcript.chunksBucket.set(chunk.chunkId, chunk);
				const queueWaitMsRaw = chunk.receivedAtMs != null ? Date.now() - chunk.receivedAtMs : null;
				const queueWaitMs = queueWaitMsRaw != null && queueWaitMsRaw < 0 ? 0 : queueWaitMsRaw;
				if (queueWaitMsRaw != null && queueWaitMsRaw < 0) {
					logger.warn(COMPONENT, 'timing_clock_skew', 'queueWaitMs was negative; clamped to 0', { transcriptId, chunkId: chunk.chunkId, queueWaitMsRaw });
				}
				const audioBuffer = Buffer.from(chunk.audio).toString('base64');
				const sttStartMs = Date.now();
				let countedCall = false;

				try {
					const response = await fetchWithTimeout(postUrl, {
						method: 'POST',
						headers: getSttHeaders(sttAuthToken),
						body: JSON.stringify({
							transcriptId: transcriptId,
							chunkId: chunk.chunkId,
							chunkStartTimeMs: chunk.chunkStartTimeMs,
							audio: audioBuffer,
						}),
					}, workerTimeouts.sttTimeoutMs);

					appMetrics.increment('stt_calls_total');
					countedCall = true;

					if (response.status !== 200) {
						const status = response.status;

						// Auth failure from Wrapper: do not retry; log and abort by throwing.
						if (status === 401 || status === 403) {
							appMetrics.increment('stt_errors_total');
							const errLatencyMs = Math.max(0, Date.now() - sttStartMs);
							appMetrics.observe('stt_latency_ms', errLatencyMs);
							if (queueWaitMs != null) appMetrics.observe('stt_queue_wait_ms', queueWaitMs);

							recordChunkFailure(transcriptId, chunk, {
								statusCode: status,
								retryCount: chunk.retryCount ?? 0,
								errorClass: 'SttUnauthorized',
								message: response.statusText || 'STT auth failed (Wrapper returned 401/403)',
								queueWaitMs,
							});

							logger.error(COMPONENT, 'stt_response_failed', 'STT auth failed (Wrapper returned 401/403)', {
								transcriptId,
								chunkId: chunk.chunkId,
								statusCode: status,
								errorClass: 'SttUnauthorized',
								retryCount: chunk.retryCount ?? 0,
							});

							// Abort processing; session-manager should surface this and abort the meeting.
							const authError = new Error('STT auth failed (Wrapper returned 401/403)');
							authError.statusCode = status;
							authError.errorClass = 'SttUnauthorized';
							throw authError;
						}
                        chunk.retryCount++;
                        if (status === 429) {
                            if (chunk.retryCount < MAX_RETRIES) {
                                // Retry later at the end so one throttled chunk doesn't block newer chunks.
                                transcript.chunksQueue.push(chunk);
                                transcript.chunksBucket.delete(chunk.chunkId);
                                logger.warn(COMPONENT, 'stt_response_failed', 'STT returned 429; re-queued to tail', {
                                    transcriptId,
                                    chunkId: chunk.chunkId,
                                    statusCode: 429,
                                    errorClass: 'SttNon200',
                                    retryCount: chunk.retryCount,
                                });
                                continue;
                            }
                        }

                        // Non-auth errors: keep existing retry behavior.
						if (chunk.retryCount < MAX_RETRIES) {
							// Retry later: requeue to the end so we don't block other chunks.
							transcript.chunksQueue.push(chunk);
							transcript.chunksBucket.delete(chunk.chunkId);
							continue;
						}

						appMetrics.increment('stt_errors_total');
						const errLatencyMs = Math.max(0, Date.now() - sttStartMs);
						appMetrics.observe('stt_latency_ms', errLatencyMs);
						if (queueWaitMs != null) appMetrics.observe('stt_queue_wait_ms', queueWaitMs);
                        const failureMessage = status === 429
                            ? 'Too Many Requests'
                            : (response.statusText || 'STT request failed');
						recordChunkFailure(transcriptId, chunk, {
							statusCode: status,
							retryCount: chunk.retryCount,
							errorClass: 'SttNon200',
							message: failureMessage,
							queueWaitMs,
						});
						logger.error(COMPONENT, 'stt_response_failed', 'STT response non-200 after retries', {
							transcriptId,
							chunkId: chunk.chunkId,
							statusCode: status,
							errorClass: 'SttNon200',
							retryCount: chunk.retryCount,
						});
						continue;
					}

					const responseJson = await response.json();
					const latencyMsRaw = Date.now() - sttStartMs;
					const latencyMs = latencyMsRaw < 0 ? 0 : latencyMsRaw;
					if (latencyMsRaw < 0) {
						logger.warn(COMPONENT, 'timing_clock_skew', 'latencyMs was negative; clamped to 0', { transcriptId, chunkId: chunk.chunkId, latencyMsRaw });
					}
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
					if (transcript.transcriptState.processedSinceFlush >= FLUSH_AFTER_PROCESSED_CHUNKS) {
						await appendToTemp(transcriptId);
					}
				} catch (error) {
					if (!countedCall) appMetrics.increment('stt_calls_total');
					appMetrics.increment('stt_errors_total');
					transcript.chunksBucket.delete(chunk.chunkId);

					chunk.retryCount = (chunk.retryCount || 0) + 1;
					if (chunk.retryCount < MAX_RETRIES) {
						// Retry later: requeue to the end so we don't block other chunks.
						transcript.chunksQueue.push(chunk);
						continue;
					}
					const isTimeout = error?.isSttTimeout === true;
					recordChunkFailure(transcriptId, chunk, {
						retryCount: chunk.retryCount,
						errorClass: isTimeout ? 'SttTimeout' : 'SttRequestFailed',
						innerErrorClass: error.constructor?.name || 'Error',
						message: error.message,
					});
					continue;
				}
			}
			if (transcript.processedChunks.length > 0) {
				await appendToTemp(transcriptId);
			}
			transcript.inFlight = false;
		} catch (error) {
			transcript.inFlight = false;
			throw error;
		}
	}

	function listMissingChunks(fileContent) {
		const lines = typeof fileContent === 'string' ? fileContent.split('\n').filter(Boolean) : [];
		const knownChunkIds = new Set();
		for (const line of lines) {
			try {
				const obj = JSON.parse(line);
				if (typeof obj.chunkId === 'number') knownChunkIds.add(obj.chunkId);
			} catch {
				// skip non-JSON or malformed lines
			}
		}
		if (knownChunkIds.size === 0) return [];
		const maxId = Math.max(...knownChunkIds);
		const missing = [];
		for (let i = 0; i <= maxId; i++) {
			if (!knownChunkIds.has(i)) missing.push(i);
		}
		return missing;
	}

	/** Sort JSONL lines by clockTimeMs (primary, chronological), then chunkId (secondary, so gaps sit next to the right chunk). Lines without numeric clockTimeMs sort after numeric ones (same tie-break: chunkId, then original index). */
	function sortTranscriptLines(fileContent) {
		const lines = typeof fileContent === 'string' ? fileContent.split('\n').filter(Boolean) : [];
		const withKeys = lines.map((line, index) => {
			try {
				const obj = JSON.parse(line);
				const chunkId = typeof obj.chunkId === 'number' ? obj.chunkId : Infinity;
				const clockTimeMs = obj.clockTimeMs;
				const hasNumericTime = typeof clockTimeMs === 'number';
				const timeForSort = hasNumericTime ? clockTimeMs : Infinity;
				return { line, chunkId, timeForSort, index };
			} catch {
				return { line, chunkId: Infinity, timeForSort: Infinity, index };
			}
		});
		withKeys.sort((a, b) => {
			if (a.timeForSort !== b.timeForSort) return a.timeForSort - b.timeForSort;
			if (a.chunkId !== b.chunkId) return a.chunkId - b.chunkId;
			return a.index - b.index;
		});
		return withKeys.map(({ line }) => line).join('\n');
	}

	async function closeTranscript(transcriptId, { channelId, participantDisplayNames, closure } = {}) {
        try {
            if (!transcriptsMap.has(transcriptId)) {
                throw new Error('Transcript not found');
            }
            const transcript = transcriptsMap.get(transcriptId);

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
					const failedChunkStartTimes = transcript.failedChunks.map((chunk) => `chunkId ${chunk.chunkId}: ${chunk.chunkStartTimeMs}ms`).join(', ');
					logger.warn(COMPONENT, 'transcript_closed', 'Transcript closed with failed chunks; some segments missing', {
						transcriptId,
						failedChunkCount: transcript.failedChunks.length,
						failedChunkStartTimes,
					});

					// Persist explicit gap markers in the transcript timeline.
					addGapMarkers(transcriptId);
					await appendToTemp(transcriptId);
					transcript.failedChunks = [];
				}
			}

			const emptyTranscriptMessage =
				'No transcript segments were produced. Ensure the STT wrapper is running and reachable, and that voice capture is receiving audio (see docs/TROUBLESHOOTING.md).';
			let tmpContent;
			try {
				tmpContent = await fsImpl.promises.readFile(transcript.transcriptState.tmpPath, 'utf8');
			} catch (err) {
				if (err.code !== 'ENOENT') throw err;
				throw new Error(emptyTranscriptMessage);
			}
			const missingChunkIds = listMissingChunks(tmpContent);
			if (missingChunkIds.length > 0) {
				addGapMarkers(transcriptId, missingChunkIds);
				await appendToTemp(transcriptId);
				tmpContent = await fsImpl.promises.readFile(transcript.transcriptState.tmpPath, 'utf8');
			}
			const sortedContent = sortTranscriptLines(tmpContent);
			const lines = sortedContent.split('\n').filter(Boolean);
			let hasSegments = false;
			for (const line of lines) {
				try {
					const obj = JSON.parse(line);
					// Segment lines have type === 'segment'; gap lines have type === 'gap'
					if (obj.type === 'segment') {
						hasSegments = true;
						break;
					}
				} catch (_) { /* skip malformed lines */ }
			}
			if (!hasSegments) throw new Error(emptyTranscriptMessage);
			const transcriptPath = transcript.transcriptState.filePath;
			const tmpPath = transcript.transcriptState.tmpPath;
			await writeTranscriptHeader(transcriptPath, {
				transcriptId,
				channelId: channelId,
				meetingStartIso: transcript.meetingStartIso,
				participantDisplayNames: participantDisplayNames,
				closure,
			});
			await fsImpl.promises.appendFile(transcriptPath, sortedContent);
			await fsImpl.promises.unlink(tmpPath).catch(() => {});
			transcriptsMap.delete(transcriptId);
			logger.info(COMPONENT, 'transcript_closed', 'Transcript closed', {
				transcriptId,
				channelId: channelId ?? null,
				filePath: transcriptPath,
			});
			return true;
		} catch (error) {
			logger.error(COMPONENT, 'transcript_close_failed', 'Failed to close transcript', {
				transcriptId,
				errorClass: 'TranscriptCloseFailed',
				innerErrorClass: error.constructor?.name || 'Error',
				message: error.message,
			});
			throw error;
		}
	}

	return {
		startTranscript,
		enqueueChunk,
		closeTranscript,
	};
}

module.exports = { createTranscriptWorker };
