const prism = require('prism-media');
const { ButtonBuilder, ButtonStyle, ActionRowBuilder, MessageFlags } = require('discord.js');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const { interactionErrorHelper } = require('../utils/interaction-errors.js');
const logger = require('../services/logger/logger.js');
const appMetrics = require('../services/metrics/metrics.js');

const COMPONENT = 'meeting-controller';
const LATE_JOINER_DM =
	'A meeting with recording is in progress in this channel. To join as a participant, click **Accept** on the disclaimer message in the channel. To decline being recorded, click **Reject**.';

function getCloseFailureMessage(error, closeErrorClass) {
    if (error.statusCode === 401 || error.statusCode === 403) {
        return error.errorClass === 'SttUnauthorized'
            ? 'The meeting was aborted: an internal authentication error occurred (Worker ↔ STT). Please contact the operator to verify service configuration.'
            : 'The meeting was aborted: an internal authentication error occurred (Bot ↔ Worker). Please contact the operator to verify service configuration.';
    }
    if (closeErrorClass === 'EmptyTranscript') {
        return 'The meeting has ended. The transcript could not be generated.';
    }
    if (closeErrorClass === 'SummaryGenerationFailed') {
        return 'The meeting has ended. The report was saved, but the summary could not be generated. You can open the report file to read the transcript.';
    }
    if (closeErrorClass === 'ReportGenerationFailed') {
        return 'The meeting has ended. The transcript was saved, but the report could not be generated.';
    }
    return 'The meeting has ended. There was a problem closing the session; the transcript, report, or summary may be missing or incomplete.';
}

function createMeetingController(controllerConfig, sessionStore) {
    const { meetingTimeouts } = controllerConfig;
    const confirmMsgToSession = new Map();

    async function connectToChannel(sessionId) {
        try {
            const sessionState = sessionStore.getSessionById(sessionId);
            
            const voiceConnection = joinVoiceChannel({
                channelId: sessionState.voiceChannelId,
                guildId: sessionState.originalInteraction.guild.id,
                adapterCreator: sessionState.originalInteraction.guild.voiceAdapterCreator,
                selfDeaf: false
            });
            voiceConnection.on('error', (error) => {
                logger.error(COMPONENT, 'voice_connection_failed', 'Voice connection error', {
                    sessionId,
                    errorClass: 'VoiceConnectionError',
                    message: error.message,
                });
            });
            sessionState.voiceConnection = voiceConnection;
            return true;
        }
        catch (error) {
            throw error;
        }
    }

    async function sendMeetingStartMessage(interaction) {
		const acceptButton = new ButtonBuilder()
			.setCustomId('disclaimer-accept')
			.setLabel('Accept')
			.setStyle(ButtonStyle.Success);

		const rejectButton = new ButtonBuilder()
			.setCustomId('disclaimer-reject')
			.setLabel('Reject')
			.setStyle(ButtonStyle.Danger);

		const buttonsRow = new ActionRowBuilder()
			.addComponents(acceptButton, rejectButton);

		return await interaction.reply({
			content: 'bot presentation, meeting start message and disclaimer message placeholder.',
			components: [buttonsRow],
		});
    }

    function unsubscribeFromStream(sessionId, participantId) {
        const sessionState = sessionStore.getSessionById(sessionId);
        try {
            const participantState = sessionState.participantStates.get(participantId);
            if (participantState.subscription) {
                if (participantState.pcmStream) {
                    participantState.pcmStream.removeAllListeners();
                    participantState.pcmStream = null;
                }
                participantState.subscription.destroy();
                participantState.subscription = null;

            }
        } catch (error) {
            throw error;
        }
    }

    function subscribeToStream(sessionId, participantId) {
        try {
            const sessionState = sessionStore.getSessionById(sessionId);
            const participantState = sessionState.participantStates.get(participantId);
            if (participantState.subscription) {
                return true;
            }
            const options = {
                end: {
                    behavior: EndBehaviorType.Manual
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
            participantState.subscription = receiver.subscribe(participantId, options);
            participantState.subscription.on('error', (error) => {
                logger.error(COMPONENT, 'voice_connection_failed', 'Subscription error', {
                    sessionId,
                    participantId,
                    errorClass: 'VoiceConnectionError',
                    innerErrorClass: error.constructor?.name || 'Error',
                    message: error.message,
                });
                unsubscribeFromStream(sessionId, participantId);
            });
            participantState.subscription.on('end', () => {
                logger.info(COMPONENT, 'subscription_end', 'Subscription stream ended', {
                    sessionId,
                    participantId,
                });
            });
            decoder.on('error', (error) => {
                logger.error(COMPONENT, 'voice_connection_failed', 'Decoder error', {
                    sessionId,
                    participantId,
                    errorClass: 'VoiceConnectionError',
                    innerErrorClass: error.constructor?.name || 'Error',
                    message: error.message,
                });
            });

            participantState.pcmStream = participantState.subscription.pipe(decoder);
            logger.info(COMPONENT, 'subscription_ok', 'Subscribed to participant PCM stream', {
                sessionId,
                participantId,
            });
        } catch (error) {
            throw error;
        }
    }

    async function registerParticipant(sessionId, participantId, interaction) {
        const sessionState = sessionStore.getSessionById(sessionId);
        if (!sessionState.voiceConnection) {
            try {
                if (!(await connectToChannel(sessionId))) {
                    logger.error(COMPONENT, 'participant_accept_failed', 'Failed to connect to voice channel', {
                        sessionId,
                        participantId,
                        errorClass: 'ConnectFailed',
                    });
                    return false;
                }
            } catch (error) {
                logger.error(COMPONENT, 'participant_accept_failed', 'Failed to connect to voice channel', {
                    sessionId,
                    participantId,
                    errorClass: 'ConnectFailed',
                    message: error.message,
                });
                await interaction.editReply({
                    content: 'An error occurred while registering you as a participant. Please try again.',
                    flags: MessageFlags.Ephemeral,
                });
                return false;
            }
        }
        if (sessionState.timeouts.uiTimeoutId) {
            clearTimeout(sessionState.timeouts.uiTimeoutId);
            sessionState.timeouts.uiTimeoutId = null;
        }
        if (sessionState.paused) {
            clearTimeout(sessionState.timeouts.pauseTimeoutId);
            sessionState.timeouts.pauseTimeoutId = null;
            sessionState.timeouts.pauseTimeoutId = setTimeout(async () => {
                await executeClose(sessionId, true);
            }, meetingTimeouts.explicitPauseMs);
        }
        if (!sessionState.started) {
            const started = await interaction.client.sessionManager.startSession(sessionId);
            if (!started) {
                logger.error(COMPONENT, 'participant_accept_failed', 'Failed to start session for participant', {
                    sessionId,
                    participantId,
                    errorClass: 'StartSessionFailed',
                });
                await interaction.editReply({
                    content: 'An error occurred while registering you as a participant. Please try again.',
                    flags: MessageFlags.Ephemeral,
                });
                return false;
            }
            sessionState.started = true;
        }
        sessionState.participantIds.push(participantId);
        const participantState = {
            subscription: null,
            displayName: interaction.user.displayName,
            pcmStream: null,
            chunkerState: {
                chunkClockTimeMs: null,
                samplesBuffer: Buffer.alloc(0),
                samplesInBuffer: 0,
                totalSamplesEmitted: 0,
            }
        };

        sessionState.participantStates.set(participantId, participantState);
        logger.info(COMPONENT, 'participant_accepted', 'Participant accepted disclaimer', {
            sessionId,
            participantId,
        });
        try {
            if (!sessionState.paused) {
                subscribeToStream(sessionId, participantId);
                interaction.client.sessionManager.chunkStream(sessionId, participantId);
                await sessionState.originalInteraction.followUp({
                    content: `<@${participantId}> has accepted the disclaimer and is included in the meeting's transcript.`,
                });
            } else {
                await sessionState.originalInteraction.followUp({
                    content: `<@${participantId}> has accepted the disclaimer and is included in the meeting's transcript, but recording is paused.`,
                });
            }
        } catch (err) {
            logger.error(COMPONENT, 'participant_accept_failed', 'Subscribe, chunkStream, or followUp failed', {
                sessionId,
                participantId,
                errorClass: 'ParticipantRegistrationFailed',
                innerErrorClass: err?.constructor?.name || 'Error',
                message: err?.message,
            });
            return false;
        }
        return true;
    }

    function reconnectParticipant(sessionId, participantId) {
        const sessionState = sessionStore.getSessionById(sessionId);
        if (!sessionState) {
            logger.error(COMPONENT, 'participant_reconnect_failed', 'Session not found', {
                sessionId,
                errorClass: 'SessionNotFound',
            });
            return false;
        }
        const participantState = sessionState.participantStates.get(participantId);
        if (!participantState) {
            logger.error(COMPONENT, 'participant_reconnect_failed', 'Participant not found', {
                sessionId,
                participantId,
                errorClass: 'ParticipantNotFound',
            });
            return false;
        }
        if (sessionState.paused) {
            clearTimeout(sessionState.timeouts.pauseTimeoutId);
            sessionState.timeouts.pauseTimeoutId = null;
            sessionState.timeouts.pauseTimeoutId = setTimeout(async () => {
                await executeClose(sessionId, true);
            }, meetingTimeouts.explicitPauseMs);
            return;
        }
        try {
            if (participantState.subscription) {
                unsubscribeFromStream(sessionId, participantId);
            }
            subscribeToStream(sessionId, participantId);
            sessionState.originalInteraction.client.sessionManager.chunkStream(sessionId, participantId);
            logger.info(COMPONENT, 'participant_reconnected', 'Participant re-subscribed after reconnect', {
                sessionId,
                participantId,
            });
            return true;
        }
        catch (error) {
            logger.error(COMPONENT, 'participant_reconnect_failed', 'Re-subscribe or chunkStream failed for participant', {
                sessionId,
                participantId,
                errorClass: 'ReconnectFailed',
                innerErrorClass: error.constructor?.name || 'Error',
                message: error.message,
            });
            return false;
        }
    }

    function stopVoiceCapture(sessionId) {
        try {
            const sessionState = sessionStore.getSessionById(sessionId);
            for (const participantId of sessionState.participantIds) {
                unsubscribeFromStream(sessionId, participantId);
            }
            if (sessionState.voiceConnection) {
                sessionState.voiceConnection.destroy();
                sessionState.voiceConnection = null;
            }
            return true;
        }
        catch (error) {
            throw error;
        }
    }

    async function getSessionTextChannel(sessionState) {
        const client = sessionState?.originalInteraction?.client;
        if (!client) {
            throw new Error('SessionClientUnavailable');
        }
        if (!sessionState?.textChannelId) {
            throw new Error('SessionTextChannelMissing');
        }
        const textChannel = await client.channels.fetch(sessionState.textChannelId);
        if (!textChannel?.isTextBased?.() || typeof textChannel.send !== 'function') {
            throw new Error('SessionTextChannelInvalid');
        }
        return textChannel;
    }

    async function sendSessionChannelMessage(sessionState, content) {
        try {
            const textChannel = await getSessionTextChannel(sessionState);
            await textChannel.send({ content });
            return { ok: true, error: null };
        } catch (error) {
            return { ok: false, error };
        }
    }

    async function executeClose(sessionId, autoClose = false) {
        const sessionState = sessionStore.getSessionById(sessionId);
        if (!sessionState) {
            logger.error(COMPONENT, 'session_close_failed', 'Session not found', {
                sessionId,
                errorClass: 'SessionNotFound',
            });
            return false;
        }
        const disabledAccept = new ButtonBuilder()
            .setCustomId('disclaimer-accept')
            .setLabel('Accept')
            .setStyle(ButtonStyle.Success)
            .setDisabled(true);
        const disabledReject = new ButtonBuilder()
            .setCustomId('disclaimer-reject')
            .setLabel('Reject')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(true);
        const disabledRow = new ActionRowBuilder().addComponents(disabledAccept, disabledReject);

        const client = sessionState.originalInteraction.client;
        if (sessionState.timeouts.uiTimeoutId) {
            clearTimeout(sessionState.timeouts.uiTimeoutId);
            sessionState.timeouts.uiTimeoutId = null;
        }
        if (sessionState.timeouts.pauseTimeoutId) {
            clearTimeout(sessionState.timeouts.pauseTimeoutId);
            sessionState.timeouts.pauseTimeoutId = null;
        }
        try {
            stopVoiceCapture(sessionId);

            const closeResult = await client.sessionManager.closeSession(sessionId, {
                autoClose,
                closeReason: autoClose ? 'inactivity' : 'manual',
                closedAtMs: Date.now(),
            });
            if (!closeResult) {
                return false;
            }
            const { summary } = closeResult;
            const closeMessage = autoClose ?
            'Meeting closed due to inactivity. The partial report is saved.' :
            `The meeting is over. Thank you for participating. \n\n**Summary:**\n${summary}`;
            const sendResult = await sendSessionChannelMessage(sessionState, closeMessage);
            if (!sendResult.ok) {
                logger.error(COMPONENT, 'session_close_failed', 'Failed to send close message to text channel', {
                    sessionId,
                    textChannelId: sessionState?.textChannelId ?? null,
                    errorClass: 'CloseMeetingFailed',
                    innerErrorClass: sendResult.error?.constructor?.name || 'Error',
                    message: sendResult.error?.message,
                });
                return false;
            }

            appMetrics.increment('meetings_closed_total');
            logger.info(COMPONENT, 'session_closed', 'Meeting closed', {
                sessionId,
                autoClose,
            });
            return true;
        } catch (error) {
            const closeErrorClass = error.closeErrorClass || 'CloseSessionFailed';
            logger.error(COMPONENT, 'session_close_failed', 'Close meeting failed', {
                sessionId,
                errorClass: closeErrorClass,
                innerErrorClass: error.constructor?.name || 'Error',
                message: error.message,
            });
            const failureMessage = getCloseFailureMessage(error, closeErrorClass);
            const failureSendResult = await sendSessionChannelMessage(sessionState, failureMessage);
            if (!failureSendResult.ok) {
                logger.error(COMPONENT, 'session_close_failed', 'Failed to send failure message to text channel', {
                    sessionId,
                    textChannelId: sessionState?.textChannelId ?? null,
                    errorClass: 'CloseMeetingFailed',
                    innerErrorClass: failureSendResult.error?.constructor?.name || 'Error',
                    message: failureSendResult.error?.message,
                });
            }
            return false;
        } finally {
            try {
                sessionStore.deleteSession(sessionId);
                const textChannel = await getSessionTextChannel(sessionState);
                const message = await textChannel.messages.fetch(sessionId);
                await message.edit({ components: [disabledRow] });
            } catch (editError) {
                logger.error(COMPONENT, 'session_close_failed', 'Failed to disable disclaimer buttons', {
                    sessionId,
                    textChannelId: sessionState?.textChannelId ?? null,
                    errorClass: 'CloseMeetingFailed',
                    innerErrorClass: editError?.constructor?.name || 'Error',
                    message: editError?.message,
                });
            }
        }
    }

    async function handleButtonInteraction(interaction) {
        const messageId = interaction?.message?.id;
        const userId = interaction?.user?.id;
        let sessionId = messageId;
        let sessionState = sessionStore.getSessionById(messageId);
        if (interaction.customId === 'close-meeting-confirm') {
            sessionId = confirmMsgToSession.get(messageId);
            if (sessionId) sessionState = sessionStore.getSessionById(sessionId);
        }
        if (!sessionState) {
            await interaction.deferUpdate();
            return;
        }
        try {
            switch (interaction.customId) {
                case 'disclaimer-accept':
                    if (!sessionState.participantIds.includes(userId) && !sessionState.rejectedIds.includes(userId)) {
                        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                        if (await registerParticipant(messageId, userId, interaction)) {
                            await interaction.editReply({
                                content: 'Disclaimer accepted. You are now a participant in the meeting and being recorded.',
                            });
                            break;
                        } else {
                            await interaction.editReply({
                                content: 'An error occurred while adding you as a participant.',
                            });
                            break;
                        }
                    }
                    await interaction.deferUpdate();
                    break;

                case 'disclaimer-reject':
                    if (!sessionState.participantIds.includes(userId) && !sessionState.rejectedIds.includes(userId)) {
                        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                        sessionState.rejectedIds.push(userId);
                        await interaction.editReply({
                            content: 'Disclaimer rejected. You are not a participant in the meeting and will not be recorded.',
                        });
                        break;
                    }
                    await interaction.deferUpdate();
                    break;
            
                case 'close-meeting-confirm':
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    if (sessionState.timeouts.uiTimeoutId) {
                        clearTimeout(sessionState.timeouts.uiTimeoutId);
                        sessionState.timeouts.uiTimeoutId = null;
                    }

                    if (!(await executeClose(sessionId))) {
                        await interactionErrorHelper(interaction, 'The meeting has ended. See the message above for details.');
                        break;
                    }
                    confirmMsgToSession.delete(interaction.message.id);
                    await interaction.deleteReply();
                    break;

                default:
                    await interaction.deferUpdate();
                    break;
            }
        } catch (error) {
            logger.error(COMPONENT, 'button_interaction_failed', 'Button interaction threw', {
                customId: interaction?.customId,
                errorClass: 'ButtonInteractionFailed',
                innerErrorClass: error?.constructor?.name || 'Error',
                message: error?.message,
                code: error?.code,
            });
            await interactionErrorHelper(interaction, 'An error occurred while handling the button interaction.');
        }
    }

    async function startMeeting(interaction) {
        try {
            const originalInteraction = interaction;
            const guildId = interaction.guild?.id ?? null;
            const textChannelId = interaction.channelId ?? null;
            const voiceChannel = interaction.member.voice.channel;
            const voiceChannelId = voiceChannel?.id ?? null;
            const interactionResponse = await sendMeetingStartMessage(interaction);

            const replyMessageObject = await interactionResponse.fetch();
            const sessionId = replyMessageObject.id;

            const sessionState = {
                started: false,
                paused: false,
                participantIds: [],
                rejectedIds: [],
                dmIds: [],
                initialMemberIds: Array.from(voiceChannel.members?.keys?.() ?? []),
                participantStates: new Map(),
                guildId,
                textChannelId,
                voiceChannelId,
                originalInteraction,
                timeouts:{uiTimeoutId: null, pauseTimeoutId: null},
            };
            const uiTimeoutId = setTimeout(async () => {
                const session = sessionStore.getSessionById(sessionId);
                if (session) {
                    try {
                        session.timeouts.uiTimeoutId = null;
                        await session.originalInteraction.followUp({
                            content: 'Session timed out after 1 minute. All participants must accept to start the meeting.',
                        });
                    }
                    catch (error) {
                        logger.error(COMPONENT, 'session_start_failed', 'Error following up on session timeout', {
                            sessionId,
                            errorClass: 'SessionTimeoutFollowUpFailed',
                            innerErrorClass: error.constructor?.name || 'Error',
                            message: error.message,
                        });
                        return false;
                    }
                }
                sessionStore.deleteSession(sessionId);
                logger.info(COMPONENT, 'session_closed', 'Session timed out and deleted', {
                    sessionId,
                });
            }, meetingTimeouts.uiTimeoutMs);

            sessionState.timeouts.uiTimeoutId = uiTimeoutId;
            sessionStore.createSession(sessionId, sessionState);
            appMetrics.increment('meetings_started_total');
            logger.info(COMPONENT, 'session_started', 'Meeting started', {
                sessionId,
                guildId,
                textChannelId,
                voiceChannelId,
                initiator: interaction.user?.id ?? null,
            });
            return true;
        } catch (error) {
            logger.error(COMPONENT, 'session_start_failed', 'Error starting meeting', {
                guildId,
                textChannelId,
                voiceChannelId,
                errorClass: 'StartMeetingFailed',
                innerErrorClass: error.constructor?.name || 'Error',
                message: error.message,
            });
            throw error;
        }
    }

    async function pauseMeeting(sessionId) {
        const sessionState = sessionStore.getSessionById(sessionId);
        if (!sessionState) {
            logger.error(COMPONENT, 'session_pause_failed', 'Session not found', {
                sessionId,
                errorClass: 'SessionNotFound',
            });
            return false;
        }
        try {
            stopVoiceCapture(sessionId);
            const client = sessionState.originalInteraction.client;
            sessionState.paused = true;
            const paused = await client.sessionManager.pauseSession(sessionId);
            if (!paused) {
                sessionState.paused = false;
                logger.error(COMPONENT, 'session_pause_failed', 'Session manager did not acknowledge pause', {
                    sessionId,
                    errorClass: 'PauseSessionFailed',
                });
                const pauseSendResult = await sendSessionChannelMessage(
                    sessionState,
                    'Failed to pause the meeting recording; recording is still active.',
                );
                if (!pauseSendResult.ok) {
                    logger.error(COMPONENT, 'session_pause_failed', 'Failed to send pause failure message to text channel', {
                        sessionId,
                        textChannelId: sessionState?.textChannelId ?? null,
                        errorClass: 'PauseSessionFailed',
                        innerErrorClass: pauseSendResult.error?.constructor?.name || 'Error',
                        message: pauseSendResult.error?.message,
                    });
                }
                return false;
            }
            logger.info(COMPONENT, 'session_paused', 'Recording paused', {
                sessionId,
                reason: 'explicit',
            });
            const pauseTimeoutId = setTimeout(async () => {
                await executeClose(sessionId, true);
            }, meetingTimeouts.explicitPauseMs);
            sessionState.timeouts.pauseTimeoutId = pauseTimeoutId;
            return true;
        } catch (error) {
            sessionState.paused = false;
            logger.error(COMPONENT, 'session_pause_failed', 'Error pausing meeting', {
                sessionId,
                errorClass: 'PauseSessionFailed',
                innerErrorClass: error.constructor?.name || 'Error',
                message: error.message,
            });
            const pauseSendResult = await sendSessionChannelMessage(
                sessionState,
                'Failed to pause the meeting recording; recording is still active.',
            );
            if (!pauseSendResult.ok) {
                logger.error(COMPONENT, 'session_pause_failed', 'Failed to send pause failure message to text channel', {
                    sessionId,
                    textChannelId: sessionState?.textChannelId ?? null,
                    errorClass: 'PauseSessionFailed',
                    innerErrorClass: pauseSendResult.error?.constructor?.name || 'Error',
                    message: pauseSendResult.error?.message,
                });
            }
            return false;
        }
    }

    async function resumeMeeting(sessionId) {
        const sessionState = sessionStore.getSessionById(sessionId);
        if (!sessionState) {
            logger.error(COMPONENT, 'session_resume_failed', 'Session not found', {
                sessionId,
                errorClass: 'SessionNotFound',
            });
            return false;
        }
        try {
            if (!sessionState.voiceConnection) {
                if (!(await connectToChannel(sessionId))) {
                    logger.error(COMPONENT, 'session_resume_failed', 'Failed to connect to channel', {
                        sessionId,
                        errorClass: 'ConnectFailed',
                    });
                    const resumeSendResult = await sendSessionChannelMessage(
                        sessionState,
                        'Failed to resume the meeting recording; the meeting remains paused.',
                    );
                    if (!resumeSendResult.ok) {
                        logger.error(COMPONENT, 'session_resume_failed', 'Failed to send resume failure message to text channel', {
                            sessionId,
                            textChannelId: sessionState?.textChannelId ?? null,
                            errorClass: 'ResumeSessionFailed',
                            innerErrorClass: resumeSendResult.error?.constructor?.name || 'Error',
                            message: resumeSendResult.error?.message,
                        });
                    }
                    return false;
                }
            }
            if (sessionState.timeouts.pauseTimeoutId) {
                clearTimeout(sessionState.timeouts.pauseTimeoutId);
                sessionState.timeouts.pauseTimeoutId = null;
            }
            const voiceChannel = await sessionState.originalInteraction.guild.channels.fetch(sessionState.voiceChannelId);
            if (!voiceChannel) {
                logger.error(COMPONENT, 'session_resume_failed', 'Voice channel not found', {
                    sessionId,
                    voiceChannelId: sessionState.voiceChannelId,
                    errorClass: 'VoiceChannelNotFound',
                });
                const resumeSendResult = await sendSessionChannelMessage(
                    sessionState,
                    'Failed to resume the meeting recording; the meeting remains paused.',
                );
                if (!resumeSendResult.ok) {
                    logger.error(COMPONENT, 'session_resume_failed', 'Failed to send resume failure message to text channel', {
                        sessionId,
                        textChannelId: sessionState?.textChannelId ?? null,
                        errorClass: 'ResumeSessionFailed',
                        innerErrorClass: resumeSendResult.error?.constructor?.name || 'Error',
                        message: resumeSendResult.error?.message,
                    });
                }
                return false;
            }
            sessionState.paused = false;
            let anyReconnectFailed = false;
            for (const [_, member] of voiceChannel.members) {
                if (sessionState.participantIds.includes(member.user.id)) {
                    if (!reconnectParticipant(sessionId, member.user.id)) {
                        anyReconnectFailed = true;
                    }
                }
            }
            if (anyReconnectFailed) {
                logger.error(COMPONENT, 'session_resume_failed', 'One or more participants failed to reconnect', {
                    sessionId,
                    errorClass: 'ResumeSessionFailed',
                });
                const resumeSendResult = await sendSessionChannelMessage(
                    sessionState,
                    'Failed to resume the meeting recording; the meeting remains paused.',
                );
                if (!resumeSendResult.ok) {
                    logger.error(COMPONENT, 'session_resume_failed', 'Failed to send resume failure message to text channel', {
                        sessionId,
                        textChannelId: sessionState?.textChannelId ?? null,
                        errorClass: 'ResumeSessionFailed',
                        innerErrorClass: resumeSendResult.error?.constructor?.name || 'Error',
                        message: resumeSendResult.error?.message,
                    });
                }
                return false;
            }
            logger.info(COMPONENT, 'session_resumed', 'Recording resumed', { sessionId });
            const resumeSuccessSendResult = await sendSessionChannelMessage(sessionState, 'Meeting recording resumed.');
            if (!resumeSuccessSendResult.ok) {
                logger.error(COMPONENT, 'session_resume_failed', 'Failed to send resume success message to text channel', {
                    sessionId,
                    textChannelId: sessionState?.textChannelId ?? null,
                    errorClass: 'ResumeSessionFailed',
                    innerErrorClass: resumeSuccessSendResult.error?.constructor?.name || 'Error',
                    message: resumeSuccessSendResult.error?.message,
                });
            }
            return true;
        }
        catch (error) {
            logger.error(COMPONENT, 'session_resume_failed', 'Error resuming meeting', {
                sessionId,
                errorClass: 'ResumeSessionFailed',
                innerErrorClass: error.constructor?.name || 'Error',
                message: error.message,
            });
            const resumeSendResult = await sendSessionChannelMessage(
                sessionState,
                'Failed to resume the meeting recording; the meeting remains paused.',
            );
            if (!resumeSendResult.ok) {
                logger.error(COMPONENT, 'session_resume_failed', 'Failed to send resume failure message to text channel', {
                    sessionId,
                    textChannelId: sessionState?.textChannelId ?? null,
                    errorClass: 'ResumeSessionFailed',
                    innerErrorClass: resumeSendResult.error?.constructor?.name || 'Error',
                    message: resumeSendResult.error?.message,
                });
            }
            return false;
        }
    }

    /**
     * Handles a user joining the meeting voice channel: reconnect participant, reset pause timeout, or send late-joiner DM.
     * Call only when the meeting has already started (caller checks newSession.sessionState.started).
     */
    async function handleUserJoinedMeetingChannel(sessionId, userId, { user }) {
        const sessionState = sessionStore.getSessionById(sessionId);
        if (!sessionState || !sessionState.started) return;

        if (sessionState.rejectedIds.includes(userId)) return;

        if (sessionState.participantIds.includes(userId)) {
            if (!sessionState.paused) {
                reconnectParticipant(sessionId, userId);
            } else {
                clearTimeout(sessionState.timeouts.pauseTimeoutId);
                sessionState.timeouts.pauseTimeoutId = setTimeout(async () => {
                    await executeClose(sessionId, true);
                }, meetingTimeouts.explicitPauseMs);
            }
            return;
        }

        if (sessionState.initialMemberIds && sessionState.initialMemberIds.includes(userId)) {
            return;
        }

        if (user?.bot) return;

        if (!sessionState.dmIds.includes(userId)) {
            if (user) {
                try {
                    await user.send(LATE_JOINER_DM);
                    logger.info(COMPONENT, 'late_joiner_dm_sent', 'DM sent to late joiner', {
                        sessionId,
                        participantId: userId,
                    });
                } catch (err) {
                    logger.error(COMPONENT, 'late_joiner_dm_failed', 'Could not DM late joiner', {
                        sessionId,
                        participantId: userId,
                        errorClass: 'DmFailed',
                        message: err.message,
                    });
                }
            }
            sessionState.dmIds.push(userId);
        }
    }

    async function closeMeeting(sessionId, interaction) {
        const sessionState = sessionStore.getSessionById(sessionId);
        if (!sessionState) {
            logger.error(COMPONENT, 'session_close_failed', 'Session not found', {
                sessionId,
                errorClass: 'SessionNotFound',
            });
            return false;
        }
        const confirmButton = new ButtonBuilder()
            .setCustomId('close-meeting-confirm')
            .setLabel('Confirm')
            .setStyle(ButtonStyle.Danger);
        const confirmRow = new ActionRowBuilder().addComponents(confirmButton);
        const confirmMessage = await interaction.editReply({
            content: 'Are you sure you want to close the meeting?',
            flags: MessageFlags.Ephemeral,
            components: [confirmRow],
        });

        confirmMsgToSession.set(confirmMessage.id, sessionId);
        const uiTimeoutId = setTimeout(async () => {
            try {
                await confirmMessage.delete();
            } catch (err) {
                logger.error(COMPONENT, 'session_close_failed', 'Failed to delete confirm message', {
                    sessionId,
                    messageId: confirmMessage.id,
                    errorClass: 'CloseMeetingFailed',
                    innerErrorClass: err.constructor?.name || 'Error',
                    message: err.message,
                });
            }
            confirmMsgToSession.delete(confirmMessage.id);
        }, meetingTimeouts.uiTimeoutMs);
        sessionState.timeouts.uiTimeoutId = uiTimeoutId;
        return true;
    }

    async function autoCloseMeeting(sessionId) {
        const sessionState = sessionStore.getSessionById(sessionId);
        if (!sessionState) {
            logger.error(COMPONENT, 'session_close_failed', 'Session not found', {
                sessionId,
                errorClass: 'SessionNotFound',
            });
            return false;
        }
        try {
            if (!(await executeClose(sessionId, true))) {
                return false;
            }
            return true;
        } catch (error) {
            const closeErrorClass = error.closeErrorClass || 'CloseSessionFailed';
            logger.error(COMPONENT, 'session_close_failed', 'Auto close meeting failed', {
                sessionId,
                errorClass: closeErrorClass,
                innerErrorClass: error.constructor?.name || 'Error',
                message: error.message,
            });
            return false;
        }
    }

    return {
        startMeeting,
        closeMeeting,
        pauseMeeting,
        resumeMeeting,
        reconnectParticipant,
        handleButtonInteraction,
        handleUserJoinedMeetingChannel,
        autoCloseMeeting,
    };
}
module.exports = { createMeetingController };