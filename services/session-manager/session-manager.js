const { convertPCMToWav } = require('./convert-pcm-to-wav.js');
const logger = require('../logger/logger');
const appMetrics = require('../metrics/metrics');

const COMPONENT = 'session-manager';

function createSessionManager({
	sessionStore,
	createReportGenerator,
	createSummaryGenerator,
	transcriptWorker,
}) {
    const sessionStates = new Map();

    function cutChunk(sessionId, { participantId, participantState }, targetSamples) {
        if (!participantState) {
            console.error('participant state not found.', participantId);
            return false;
        }
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

        try {
            const chunkPCMBuffer = samplesBuffer.subarray(0, TARGET_BYTES);
            samplesBuffer = samplesBuffer.subarray(TARGET_BYTES);
            const wavBuffer = convertPCMToWav(chunkPCMBuffer, SAMPLE_RATE);
            const chunkStartSample = totalSamplesEmitted;
            const chunkStartTimeMs = (chunkStartSample / SAMPLE_RATE) * 1000;

            const chunk = {
                chunkId: getNextChunkId(sessionId),
                participantData: participantData,
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
            return chunk;
        }
        catch (error) {
            console.error('error cutting chunk.', error);
            throw error;
        }
    }

	function getNextChunkId(sessionId) {
		const sessionState = sessionStates.get(sessionId);
		if (!sessionState) {
			console.error('session not found.', sessionId);
			return false;
		}
		return sessionState.nextChunkId++;
	}

	function chunkStream(sessionId, participantId) {
		const sessionState = sessionStates.get(sessionId);
		if (!sessionState) {
			console.error('session not found.', sessionId);
			return false;
		}
		const participantState = sessionState.participantStates.get(participantId);
		if (!participantState) {
			console.error('participant state not found.', participantId);
			return false;
		}
		const TARGET_SAMPLES = 30 * 16000;
        let chunkClockTimeMs = null;
		try {
			const pcmStream = participantState.pcmStream;
			pcmStream.on('data', (pcmBuffer) => {
				let samplesInThisBuffer = pcmBuffer.length / 2;
                if (participantState.chunkerState.samplesInBuffer === 0) {
                    participantState.chunkerState.chunkClockTimeMs = Date.now();
                }
                participantState.chunkerState.samplesBuffer = Buffer.concat([
                    participantState.chunkerState.samplesBuffer,
                    pcmBuffer
                ]);
				participantState.chunkerState.samplesInBuffer += samplesInThisBuffer;

				while (participantState.chunkerState.samplesInBuffer >= TARGET_SAMPLES) {
                    try {
                        const participant = { participantId: participantId, participantState: participantState };
                        const chunk = cutChunk(sessionId, participant, TARGET_SAMPLES);
                        sessionState.chunksQueue.push(chunk);
                        ensureProcessing(sessionId);
                    }
                    catch (error) {
                        console.error('error cutting chunk.', error);
                        return false;
                    }
				}
                return true;
			});
		} catch (error) {
			console.error('error chunking stream.', error);
			return false;
		}
	}

	async function sendChunks(sessionId) {
		const sessionState = sessionStates.get(sessionId);
		if (!sessionState) {
			console.error('no session state found.', sessionId);
			return false;
		}
		while (sessionState.chunksQueue.length > 0) {
			const chunk = sessionState.chunksQueue.shift();
			try {
				await transcriptWorker.enqueueChunk(sessionId, chunk);
			} catch (error) {
				logger.error(COMPONENT, 'chunk_send_failed', 'Worker enqueueChunk failed', {
					sessionId,
					transcriptId: sessionId,
					chunkId: chunk?.chunkId,
					errorClass: error.constructor?.name || 'Error',
					message: error.message,
				});
				continue;
			}
		}
		return true;
	}

	function ensureProcessing(sessionId) {
		const sessionState = sessionStates.get(sessionId);
		if (!sessionState) {
			console.error('no session state found.', sessionId);
			return false;
		}
		if (sessionState.chunksQueue.length > 0 && !sessionState.processingPromise) {
			sessionState.processingPromise = sendChunks(sessionId)
				.finally(() => {
					sessionState.processingPromise = null;
				});
		}
		return sessionState.processingPromise;
	}

    async function pauseSession(sessionId) {
        const sessionState = sessionStates.get(sessionId);
        if (!sessionState) {
            console.error('no session state found.', sessionId);
            return false;
        }
        const storeSession = sessionStore.getSessionById(sessionId);
        if (!storeSession?.paused) {
            console.error('session not paused.', sessionId);
            return false;
        }
        try {
            for (const [participantId, participantState] of sessionState.participantStates) {
                if (!participantState?.chunkerState) {
                    console.error('participant state not found.', participantId);
                    continue;
                }
                const participant = { participantId: participantId, participantState: participantState };
                const samplesInBuffer = participantState.chunkerState.samplesInBuffer;
                if (samplesInBuffer > 0) {
                    const chunk = cutChunk(sessionId, participant, samplesInBuffer);
                    sessionState.chunksQueue.push(chunk);
                    ensureProcessing(sessionId);
                }
            }
            return true;
        } catch (error) {
            console.error('error pausing session.', error);
            throw error;
        }
    }

	async function startSession(sessionId) {
		const session = sessionStore.getSessionById(sessionId);
		if (!session) {
			console.error('session not found.', sessionId);
			return false;
		}
		try {
			const meetingStartTimeMs = Date.now();
			const sessionState = {
				nextChunkId: 0,
				chunksQueue: [],
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
			logger.error(COMPONENT, 'session_start_failed', 'Failed to start session', {
				sessionId,
				errorClass: error.constructor?.name || 'Error',
				message: error.message,
			});
			return false;
		}
	}



	async function closeSession(sessionId) {
		const sessionState = sessionStates.get(sessionId);
		if (!sessionState) {
			throw new Error('session not found.');
		}
		const transcriptPath = sessionState.transcriptPath;
		const reportGenerator = sessionState.reportGenerator;
		const summaryGenerator = sessionState.summaryGenerator;
		const displayNames = Array.from(sessionState.participantStates.values(), (ps) => ps.displayName);

		try {
			await ensureProcessing(sessionId);
			await transcriptWorker.closeTranscript(sessionId, {
				channelId: sessionState.voiceChannelId,
				participantDisplayNames: displayNames,
			});
			const reportPath = await reportGenerator.generateReport(transcriptPath);
			const summary = await summaryGenerator.generateSummary(reportPath);
			await reportGenerator.insertSummary(reportPath, summary);
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
			logger.error(COMPONENT, 'session_close_failed', 'Close session failed', {
				sessionId,
				errorClass: error.constructor?.name || 'Error',
				message: error.message,
			});
			throw new Error(error.message);
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
