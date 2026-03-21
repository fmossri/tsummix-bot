const logger = require('../logger/logger');
const appMetrics = require('../metrics/metrics');
const { convertPCMToWav } = require('../../utils/convert-pcm-to-wav.js');
const { chooseChunkingStrategy } = require('./chunking/choose-strategy.js');

const COMPONENT = 'session-manager';

function createSessionManager({
    managerConfig,
    sessionStore,
	createReportGenerator,
	createSummaryGenerator,
	transcriptWorker
}) {
    const { maxRetries: MAX_RETRIES } = managerConfig;
    const sessionStates = new Map();

    function isWorkerHealthy() {
        // v0.3: in process worker only; always healthy.
        // replace this with a call to an injected HTTP client health probe, 
        // or add a workerHealth module.
        return true;
    }

    function cutChunk(sessionId, { participantId, participantState }, targetSamples) {
        const participantData = {
            participantId: participantId,
            displayName: participantState.displayName,
        };
        const TARGET_BYTES = targetSamples * 2;
        const SAMPLE_RATE = 16000;

        let samplesBuffer = participantState.chunkerState.samplesBuffer;
        let samplesInBuffer = participantState.chunkerState.samplesInBuffer;
        let totalSamplesEmitted = participantState.chunkerState.totalSamplesEmitted;
        let chunkClockTimeMs = participantState.chunkerState.chunkClockTimeMs;

        const chunkPCMBuffer = samplesBuffer.subarray(0, TARGET_BYTES);
        samplesBuffer = samplesBuffer.subarray(TARGET_BYTES);
        const wavBuffer = convertPCMToWav(chunkPCMBuffer, SAMPLE_RATE);
        const chunkStartSample = totalSamplesEmitted;
        const chunkStartTimeMs = (chunkStartSample / SAMPLE_RATE) * 1000;

        const chunk = {
            chunkId: getNextChunkId(sessionId),
            participantData: participantData,
            sendRetryCount: 0,
            chunkClockTimeMs: chunkClockTimeMs,
            chunkStartTimeMs: chunkStartTimeMs,
            audio: wavBuffer,
        };
        totalSamplesEmitted += targetSamples;
        samplesInBuffer -= targetSamples;
        chunkClockTimeMs = Date.now();
        participantState.chunkerState.chunkClockTimeMs = chunkClockTimeMs;
        participantState.chunkerState.samplesBuffer = samplesBuffer;
        participantState.chunkerState.samplesInBuffer = samplesInBuffer;
        participantState.chunkerState.totalSamplesEmitted = totalSamplesEmitted;
        appMetrics.observe('chunk_duration_ms', (targetSamples / 16000) * 1000);
        return chunk;
    }

	function getNextChunkId(sessionId) {
		const sessionState = sessionStates.get(sessionId);
		if (!sessionState) {
            throw new Error('Invariant: sessionState missing in getNextChunkId');
		}
		return sessionState.nextChunkId++;
	}

    async function sendChunks(sessionId) {
		const sessionState = sessionStates.get(sessionId);
		if (!sessionState) {
            throw new Error('Invariant: sessionState missing in sendChunks');
		}
		while (sessionState.chunksQueue.length > 0) {
			const chunk = sessionState.chunksQueue.shift();
			try {
				await transcriptWorker.enqueueChunk(sessionId, chunk);
			} catch (error) {
				// Bot ↔ Worker auth failure: abort send loop and let higher layers close the meeting.
				if (error.statusCode === 401 || error.statusCode === 403) {
					const context = {
						sessionId,
						transcriptId: sessionId,
						chunkId: chunk?.chunkId,
						errorClass: 'WorkerUnauthorized',
						innerErrorClass: error.constructor?.name || 'Error',
						message: error.message,
						statusCode: error.statusCode,
					};
					logger.error(COMPONENT, 'chunk_send_failed', 'Worker HTTP auth failed (401/403)', context);
					throw error;
				}

				chunk.sendRetryCount++;

				if (chunk.sendRetryCount === MAX_RETRIES) {
					const context = {
						sessionId,
						transcriptId: sessionId,
						chunkId: chunk?.chunkId,
						sendRetryCount: chunk.sendRetryCount,
						errorClass: 'EnqueueChunkFailed',
						innerErrorClass: error.constructor?.name || 'Error',
						message: error.message,
					};
					if (error.statusCode != null) context.statusCode = error.statusCode;
					logger.error(COMPONENT, 'chunk_send_failed', 'Worker enqueueChunk failed after retries', context);
					continue;
				}
				sessionState.chunksQueue.push(chunk);
				continue;
			}
		}
		return true;
	}

    function ensureProcessing(sessionId) {
		const sessionState = sessionStates.get(sessionId);
		if (!sessionState) {
			throw new Error('Invariant: sessionState missing in ensureProcessing');
		}
		if (sessionState.chunksQueue.length > 0 && !sessionState.processingPromise) {
			sessionState.processingPromise = sendChunks(sessionId)
				.finally(() => {
					sessionState.processingPromise = null;
				});
		}
		return sessionState.processingPromise;
	}

	function chunkStream(sessionId, participantId) {
		const sessionState = sessionStates.get(sessionId);
		if (!sessionState) {
			logger.error(COMPONENT, 'chunk_send_failed', 'Session not found', {
				sessionId,
				participantId,
				errorClass: 'SessionNotFound',
			});
			return false;
		}
		const participantState = sessionState.participantStates.get(participantId);
		if (!participantState) {
			logger.error(COMPONENT, 'chunk_send_failed', 'Participant not found', {
				sessionId,
				transcriptId: sessionId,
				participantId,
				errorClass: 'ParticipantNotFound',
			});
			return false;
		}
		participantState.chunkerState._hasLoggedPcmData = false;
		try {
			const pcmStream = participantState.pcmStream;
			pcmStream.on('data', (pcmBuffer) => {
				let samplesInThisBuffer = pcmBuffer.length / 2;
                let samplesToCut = null;
                let now = Date.now();
				while (samplesToCut = sessionState.chunkingStrategy(participantState.chunkerState, managerConfig.chunkerConfig, now)) {
                    try {
                        const participant = { participantId: participantId, participantState: participantState };
                        const chunk = cutChunk(sessionId, participant, samplesToCut);
                        sessionState.chunksQueue.push(chunk);
                        logger.info(COMPONENT, 'chunk_cut', 'Cut chunk during meeting', {
                            sessionId,
                            participantId,
                            displayName: participantState.displayName,
                            chunkId: chunk.chunkId,
                            samplesCut: samplesToCut,
                            queueLengthAfter: sessionState.chunksQueue.length,
                        });
                        ensureProcessing(sessionId);
                    }
                    catch (error) {
                        logger.error(COMPONENT, 'chunk_send_failed', 'Error cutting chunk', {
                            sessionId,
                            transcriptId: sessionId,
                            participantId,
                            errorClass: 'ChunkCutFailed',
                            innerErrorClass: error.constructor?.name || 'Error',
                            message: error.message,
                        });
                        return false;
                    }
				}
                if (participantState.chunkerState.samplesInBuffer === 0) {
                    participantState.chunkerState.chunkClockTimeMs = Date.now();
                }
                participantState.chunkerState.samplesBuffer = Buffer.concat([
                    participantState.chunkerState.samplesBuffer,
                    pcmBuffer
                ]);
				participantState.chunkerState.samplesInBuffer += samplesInThisBuffer;
				if (!participantState.chunkerState._hasLoggedPcmData) {
					participantState.chunkerState._hasLoggedPcmData = true;
					logger.info(COMPONENT, 'pcm_data_received', 'PCM stream data', {
						sessionId,
						participantId,
						displayName: participantState.displayName,
						samplesInThisChunk: samplesInThisBuffer,
						totalSamplesInBuffer: participantState.chunkerState.samplesInBuffer,
					});
				}
                return true;
			});
		} catch (error) {
			logger.error(COMPONENT, 'chunk_send_failed', 'Error chunking stream', {
				sessionId,
				transcriptId: sessionId,
				participantId,
				errorClass: 'ChunkStreamSetupFailed',
				innerErrorClass: error.constructor?.name || 'Error',
				message: error.message,
			});
			return false;
		}
	}

    async function flushQueues(sessionId) {
        const sessionState = sessionStates.get(sessionId);
        if (!sessionState) {
            throw new Error('Invariant: sessionState missing in flushQueues');
        }
        for (const [participantId, participantState] of sessionState.participantStates) {
            if (!participantState?.chunkerState) {
                continue;
            }
            const participant = { participantId: participantId, participantState: participantState };
            const samplesInBuffer = participantState.chunkerState.samplesInBuffer;
            if (samplesInBuffer > 0) {
                try {
                    const chunk = cutChunk(sessionId, participant, samplesInBuffer);
                    sessionState.chunksQueue.push(chunk);
                    logger.info(COMPONENT, 'chunk_cut', 'Cut chunk on flush', {
                        sessionId,
                        participantId,
                        displayName: participantState.displayName,
                        chunkId: chunk.chunkId,
                        samplesFlushed: samplesInBuffer,
                        queueLengthAfter: sessionState.chunksQueue.length,
                    });
                    ensureProcessing(sessionId);
                } catch (error) {
                    logger.error(COMPONENT, 'chunk_send_failed', 'Error cutting chunk on flush', {
                        sessionId,
                        transcriptId: sessionId,
                        participantId,
                        errorClass: 'ChunkCutFailed',
                        innerErrorClass: error.constructor?.name || 'Error',
                        message: error.message,
                    });
                    throw error;
                }
            }
        }
        await ensureProcessing(sessionId);
        return true;
    }

    async function pauseSession(sessionId) {
        const sessionState = sessionStates.get(sessionId);
        if (!sessionState) {
            logger.error(COMPONENT, 'session_pause_failed', 'Session not found', {
                sessionId,
                errorClass: 'SessionNotFound',
            });
            return false;
        }
        const storeSession = sessionStore.getSessionById(sessionId);
        if (!storeSession?.paused) {
            return false;
        }
        try {
            await flushQueues(sessionId);
            return true;
        } catch (error) {
            logger.error(COMPONENT, 'session_pause_failed', 'Error pausing session', {
                sessionId,
                errorClass: 'PauseSessionFailed',
                innerErrorClass: error.constructor?.name || 'Error',
                message: error.message,
            });
            throw error;
        }
    }

	async function startSession(sessionId) {
        try {
            const session = sessionStore.getSessionById(sessionId);
            if (!session) {
                logger.error(COMPONENT, 'session_start_failed', 'Session not found', {
                    sessionId,
                    errorClass: 'SessionNotFound',
                });
                return false;
            }

			const meetingStartTimeMs = Date.now();
			const sessionState = {
				nextChunkId: 0,
				chunksQueue: [],
                chunkingStrategy: chooseChunkingStrategy(managerConfig.chunkerConfig.chunkingStrategy),
				processingPromise: null,
				transcriptPath: null,
				voiceChannelId: session.voiceChannelId,
				reportGenerator: createReportGenerator(),
				summaryGenerator: createSummaryGenerator(),
				participantStates: session.participantStates,
				meetingStartTimeMs,
			};
			sessionStates.set(sessionId, sessionState);
			sessionState.transcriptPath = await transcriptWorker.startTranscript(sessionId, meetingStartTimeMs);
			appMetrics.incrementGauge('meetings_active', 1);
			logger.info(COMPONENT, 'session_started', 'Session manager started', {
				sessionId,
				transcriptId: sessionId,
			});
			return true;
		} catch (error) {
			appMetrics.increment('session_start_failures_total');
			const context = {
				sessionId,
				errorClass: 'StartSessionFailed',
				innerErrorClass: error.constructor?.name || 'Error',
				message: error.message,
			};
			if (error.statusCode != null) context.statusCode = error.statusCode;
			logger.error(COMPONENT, 'session_start_failed', 'Failed to start session', context);
			return false;
		}
	}

	async function closeSession(sessionId, { autoClose = false, closeReason = null, closedAtMs = null } = {}) {
        let stage = 'transcript';

        try {
            const sessionState = sessionStates.get(sessionId);
            if (!sessionState) {
                logger.error(COMPONENT, 'session_close_failed', 'Session not found', {
                    sessionId,
                    errorClass: 'SessionNotFound',
                });
                return false;
            }
            const transcriptPath = sessionState.transcriptPath;
            const reportGenerator = sessionState.reportGenerator;
            const summaryGenerator = sessionState.summaryGenerator;
            const displayNames = Array.from(sessionState.participantStates.values(), (ps) => ps.displayName);

            stage = 'drain';
			await ensureProcessing(sessionId);
            await flushQueues(sessionId);

			stage = 'transcript';
			const endedAtIso = new Date(typeof closedAtMs === 'number' ? closedAtMs : Date.now()).toISOString();
			await transcriptWorker.closeTranscript(sessionId, {
				channelId: sessionState.voiceChannelId,
				participantDisplayNames: displayNames,
				closure: {
					endedAtIso,
					...(autoClose && { autoClose: true, reason: closeReason ?? 'inactivity' }),
				},
			});
			stage = 'report';
			const reportPath = await reportGenerator.generateReport(transcriptPath);
			
            stage = 'summary';
            const summary = await summaryGenerator.generateSummary(reportPath);
			await reportGenerator.insertSummary(reportPath, summary);
            
            stage = 'finalize';
			appMetrics.observe('meeting_duration_ms', Date.now() - (sessionState.meetingStartTimeMs || Date.now()));
			appMetrics.incrementGauge('meetings_active', -1);
			sessionStates.delete(sessionId);
			logger.info(COMPONENT, 'session_closed', 'Session manager closed', {
				sessionId,
				transcriptId: sessionId,
				reportPath,
			});
			return { reportPath, summary };
		} catch (error) {
			appMetrics.increment('session_close_failures_total');
			const isNoTranscript = stage === 'transcript' && typeof error?.message === 'string' && error.message.includes('No transcript segments were produced');
			const errorClass = stage === 'report'
				? 'ReportGenerationFailed'
				: stage === 'summary'
					? 'SummaryGenerationFailed'
					: isNoTranscript
						? 'EmptyTranscript'
						: 'CloseSessionFailed';
			const closeContext = {
				sessionId,
				errorClass,
				innerErrorClass: error.constructor?.name || 'Error',
				stage,
				message: error.message,
			};
			if (error.statusCode != null) closeContext.statusCode = error.statusCode;
			logger.error(COMPONENT, 'session_close_failed', 'Close session failed', closeContext);
			error.closeErrorClass = errorClass;
			// Transcript already closed at report/summary stage; treat session as closed so later close attempts don't re-close transcript.
			if (stage === 'report' || stage === 'summary') {
				const sessionState = sessionStates.get(sessionId);
				if (sessionState) {
					appMetrics.incrementGauge('meetings_active', -1);
					sessionStates.delete(sessionId);
				}
			}
			throw error;
		}
	}

	return {
		startSession,
		pauseSession,
		closeSession,
		chunkStream,
	};
}

module.exports = { createSessionManager };
