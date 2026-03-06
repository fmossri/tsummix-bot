const prism = require('prism-media');
const fetch = require('node-fetch');
const fs = require('node:fs');
const path = require('node:path');
const wav = require('node-wav');

const { sessionStore } = require('../../session.js');
const { createTranscriptWorker } = require('../transcript-worker/transcript-worker.js');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const { generateReport } = require('../report-generator/report-generator.js');
const { generateSummary } = require('../summary-generator/summary-generator.js');

if (!process.env.STT_BASE_URL) {
    console.error('STT_BASE_URL must be set in .env (e.g. http://localhost:8000)');
    process.exit(1);
}

const transcriptWorker = createTranscriptWorker({
    sttBaseUrl: process.env.STT_BASE_URL,
    fetchImpl: fetch,
    fsImpl: fs,
    pathImpl: path,
});

function createSessionManager() {
    const sessionStates = new Map();

        async function connectToChannel(sessionId) {
            const sessionState = sessionStates.get(sessionId);
            if (!sessionState) {
                console.error('session not found.', sessionId);
                return false;
            }
            try {
                const voiceConnection = await joinVoiceChannel({
                    channelId: sessionState.voiceChannelId,
                    guildId: sessionState.originalInteraction.guild.id,
                    adapterCreator: sessionState.originalInteraction.guild.voiceAdapterCreator,
                    selfDeaf: false
                });
                sessionState.voiceConnection = voiceConnection;
                console.log('voice connection established.');
                return true;
            }
            catch (error) {
                console.error('error connecting to channel.', error);
                return false;
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
        function convertPCMToWav(pcmBuffer, sampleRate) {
            const int16View = new Int16Array(
                pcmBuffer.buffer,
                pcmBuffer.byteOffset,
                pcmBuffer.length / 2
            );
            const floatSamples = new Float32Array(int16View.length);
            for (let i = 0; i < int16View.length; i++) {
                floatSamples[i] = int16View[i] / 32768;
            }
            return wav.encode([floatSamples], {sampleRate: sampleRate, bitDepth: 16});
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
                }

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
                        }
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
        

        function registerParticipantState(sessionId, participantId, participant) {
            const sessionState = sessionStates.get(sessionId);
            if (!sessionState) {
                console.error('session not found.', sessionId);
                return false;     
            }
            try {
 
                const participantState = {
                    subscription: null,
                    displayName: participant.displayName,
                    pcmStream: null,
                    chunkerState: {
                        samplesBuffer: Buffer.alloc(0),
                        samplesInBuffer: 0,
                        totalSamplesEmitted: 0,
                    }
                };
                sessionState.participantStates.set(participantId, participantState);
                return true;
            } catch (error) {
                console.error('error registering participant state.', error);
                return false;
            }
        }

        function subscribeToStream(sessionId, participantId) {
            const sessionState = sessionStates.get(sessionId);
            if (!sessionState) {
                console.error('session not found.', sessionId);
                return false;
            }
            try {
                const participant = sessionState.participantStates.get(participantId);
                if (!participant) {
                    console.error('participant not found.', participantId);
                    return false;
                }
                if (participant.subscription) {
                    return true;
                }
                const options = {
                    end: {
                        behavior: EndBehaviorType.AfterSilence,
                        duration: 100
                    }
                };
                const receiver = sessionState.voiceConnection.receiver;
                const decoder = new prism.opus.Decoder(
                    {
                        channels: 1,
                        rate: 16000,
                        frameSize: 320
                    }
                );
                participant.subscription = receiver.subscribe(participantId, options)
                participant.subscription.on('error', (error) => {
                    console.error('error subscribing to stream.', error);
                    unsubscribeFromStream(sessionId, participantId);
                });
                participant.subscription.on('end', () => {
                    console.log('stream ended.');
                    unsubscribeFromStream(sessionId, participantId);
                });
                participant.pcmStream = participant.subscription.pipe(decoder);
                return true;
            } catch (error) {
                console.error('error subscribing to stream.', error);
                return false;
            }
        }
        function unsubscribeFromStream(sessionId, participantId) {
            const sessionState = sessionStates.get(sessionId);
            if (!sessionState) {
                console.error('session not found.', sessionId);
                return false;
            }
            try {
                const participant = sessionState.participantStates.get(participantId);
                if (!participant) {
                    console.error('participant not found.', participantId);
                    return false;
                }
                if (participant.subscription) {
                    if (participant.pcmStream) {
                        participant.pcmStream.removeAllListeners();
                        participant.pcmStream = null;
                    }
                    participant.subscription.destroy();
                    participant.subscription = null;

                }
                return true;
            } catch (error) {
                console.error('error unsubscribing from stream.', error);
                return false;
            }
        }
        function resubscribeToStream(sessionId, participantId) {
            const sessionState = sessionStates.get(sessionId);
            if (!sessionState) {
                console.error('session not found.', sessionId);
                return false;
            }
            const participant = sessionState.participantStates.get(participantId);
            if (!participant) {
                console.error('participant not found.', participantId);
                return false;
            }
            try {
                if (participant.subscription) {
                    unsubscribeFromStream(sessionId, participantId);
                }
                subscribeToStream(sessionId, participantId);
                chunkStream(sessionId, participantId);
                return true;
            }
            catch (error) {
                console.error('error re-subscribing to stream.', error);
                return false;
            }
        }

        async function startVoiceCapture(sessionId) {
            const sessionState = sessionStates.get(sessionId);
            if (!sessionState) {
                console.error('session not found.', sessionId);
                return false;
            }
            try {
                if (!(await connectToChannel(sessionId))) return false;
                
                const voiceChannel = await sessionState.originalInteraction.guild.channels.cache.get(sessionState.voiceChannelId);
                if (!voiceChannel) {
                    console.error('voice channel not found.', sessionState.voiceChannelId);
                    return false;
                }
                for (const participantId of sessionState.participantIds) {
                    const participant = voiceChannel.members.get(participantId);
                    if (!participant) {
                        console.error('participant not found.', participantId);
                        continue;
                    }
                    registerParticipantState(sessionId, participantId, participant);
                    subscribeToStream(sessionId, participantId);
                    chunkStream(sessionId, participantId);
                }
            return true;
            }
            catch (error) {
                console.error('error starting meeting capture.', error);
                return false;
            }
        }
        async function stopVoiceCapture(sessionId, finished) {
            const sessionState = sessionStates.get(sessionId);
            if (!sessionState) {
                console.error('session not found.', sessionId);
                return false;
            }
            try {
                for (const participantId of sessionState.participantIds) {
                    unsubscribeFromStream(sessionId, participantId);
                }
                await ensureProcessing(sessionId);
                if (sessionState.voiceConnection) {
                    sessionState.voiceConnection.destroy();
                    sessionState.voiceConnection = null;
                }
                if (finished) {
                    const transcriptPath = await transcriptWorker.closeMeeting(sessionId);
                    if (!transcriptPath) {
                        console.error('error closing meeting.', sessionId);
                        return false;
                    }
                    console.log('transcript path:', transcriptPath);
                    sessionStates.delete(sessionId);
                    return transcriptPath;
                }
            }
            catch (error) {
                console.error('error stopping voice capture.', error);
                return false;
            }
        }

        async function startMeeting(sessionId) {
            const sessionState = sessionStore.getSessionById(sessionId);
            if (!sessionState) {
                console.error('session not found.', sessionId);
                return false;
            }
            try {
                sessionState.voiceConnection = null;
                sessionState.nextChunkId = 0;
                sessionState.chunksQueue = [];
                sessionState.processingPromise = null;
                sessionState.participantStates = new Map();
                sessionStates.set(sessionId, sessionState);

                const guild = sessionState.originalInteraction.guild;
                const participantDisplayNames = [];
                for (const participantId of sessionState.participantIds) {
                    const participantDisplayName = guild.members.cache.get(participantId)?.displayName ?? null;
                    if (!participantDisplayName) {
                        console.error('participant not found.', participantId);
                        throw new Error(`participant not found: ${participantId}`);
                    }
                    participantDisplayNames.push(participantDisplayName);
                }
                await transcriptWorker.startMeeting(sessionId, {
                    channelId: sessionState.voiceChannelId,
                    participantDisplayNames,
                });

                await startVoiceCapture(sessionId);
                return true;
            }
            catch (error) {
                console.error('error starting meeting.', error);
                return false;
            }
        }
        function pauseMeeting(sessionId) {}
        function resumeMeeting(sessionId) {}
        async function finishMeeting(sessionId) {
            const sessionState = sessionStates.get(sessionId);
            if (!sessionState) {
                console.error('session not found.', sessionId);
                return false;
            }
            try {
                const transcriptPath = await stopVoiceCapture(sessionId, true);
                if (!transcriptPath?.endsWith('.jsonl')) {
                    console.error('invalid transcript path.', transcriptPath);
                    return false;
                }
                const reportPath = await generateReport(transcriptPath);
                const summary = await generateSummary(reportPath);
                if (sessionStore.getSessionById(sessionId)) {
                    sessionStore.deleteSession(sessionId);
                }
                console.log('session closed and deleted.');
                return { reportPath, summary };
            }
            catch (error) {
                console.error('error finishing meeting.', error);
                return false;
            }
        }

    return {
        startMeeting,
        pauseMeeting,
        resumeMeeting,
        finishMeeting,
        resubscribeToStream,
    }
}

module.exports = { createSessionManager };