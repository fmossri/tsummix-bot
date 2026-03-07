const { convertPCMToWav } = require('./convert-pcm-to-wav.js');

function createSessionManager({
	sessionStore,
	createReportGenerator,
	createSummaryGenerator,
	transcriptWorker,
}) {
	const sessionStates = new Map();

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
		const TARGET_CHUNK_SECONDS = 30;
		const SAMPLE_RATE = 16000;
		const TARGET_SAMPLES = TARGET_CHUNK_SECONDS * SAMPLE_RATE;
		const TARGET_BYTES = TARGET_SAMPLES * 2;
		const participantState = sessionState.participantStates.get(participantId);
		if (!participantState) {
			console.error('participant state not found.', participantId);
			return false;
		}
		try {
			const participantData = {
				participantId: participantId,
				displayName: participantState.displayName,
			};

			let samplesBuffer = participantState.chunkerState.samplesBuffer;
			let samplesInBuffer = participantState.chunkerState.samplesInBuffer;
			let totalSamplesEmitted = participantState.chunkerState.totalSamplesEmitted;
			const pcmStream = participantState.pcmStream;
			pcmStream.on('data', (pcmBuffer) => {
				let samplesInThisBuffer = pcmBuffer.length / 2;
				samplesBuffer = Buffer.concat([samplesBuffer, pcmBuffer]);
				samplesInBuffer += samplesInThisBuffer;

				while (samplesInBuffer >= TARGET_SAMPLES) {
					const chunkPCMBuffer = samplesBuffer.subarray(0, TARGET_BYTES);
					samplesBuffer = samplesBuffer.subarray(TARGET_BYTES);
					const wavBuffer = convertPCMToWav(chunkPCMBuffer, SAMPLE_RATE);
					const chunkStartSample = totalSamplesEmitted;
					const chunkEndSample = chunkStartSample + TARGET_SAMPLES;
					const chunkStartTimeMs = (chunkStartSample / SAMPLE_RATE) * 1000;
					const chunkEndTimeMs = (chunkEndSample / SAMPLE_RATE) * 1000;

					const chunk = {
						chunkId: getNextChunkId(sessionId),
						participantData: participantData,
						chunkStartTimeMs: chunkStartTimeMs,
						chunkEndTimeMs: chunkEndTimeMs,
						audio: wavBuffer,
					};
					sessionState.chunksQueue.push(chunk);
					ensureProcessing(sessionId);
					totalSamplesEmitted += TARGET_SAMPLES;
					samplesInBuffer -= TARGET_SAMPLES;
					participantState.chunkerState.samplesBuffer = samplesBuffer;
					participantState.chunkerState.samplesInBuffer = samplesInBuffer;
					participantState.chunkerState.totalSamplesEmitted = totalSamplesEmitted;
				}
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
				console.error('error sending chunk.', error);
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

	async function startSession(sessionId) {
		const session = sessionStore.getSessionById(sessionId);
		if (!session) {
			console.error('session not found.', sessionId);
			return false;
		}
		try {
			const sessionState = {
				nextChunkId: 0,
				chunksQueue: [],
				processingPromise: null,
				transcriptPath: null,
				voiceChannelId: session.voiceChannelId,
				reportGenerator: createReportGenerator(),
				summaryGenerator: createSummaryGenerator(),
				participantStates: session.participantStates,
			};
			sessionStates.set(sessionId, sessionState);
			sessionState.transcriptPath = await transcriptWorker.startTranscript(sessionId);
			return true;
		} catch (error) {
			console.error('error starting meeting.', error);
			return false;
		}
	}

	function pauseSession(sessionId) {}
	function resumeSession(sessionId) {}

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
			sessionStates.delete(sessionId);
			console.log('session closed.');
			return { reportPath, summary };
		} catch (error) {
			throw new Error(error.message);
		}
	}

	return {
		startSession,
		closeSession,
        pauseSession,
		resumeSession,
		chunkStream,
	};
}

module.exports = { createSessionManager };
