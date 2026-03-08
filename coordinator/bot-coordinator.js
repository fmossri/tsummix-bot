const { ButtonBuilder, ButtonStyle, ActionRowBuilder, MessageFlags } = require('discord.js');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');

function createBotCoordinator(sessionStore) {
    const confirmMsgToSession = new Map();
    async function connectToChannel(sessionId) {
        const sessionState = sessionStore.getSessionById(sessionId);
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

    async function closeMeeting(sessionId, interaction) {
        const sessionState = sessionStore.getSessionById(sessionId);
        if (!sessionState) {
            console.error('session not found.', sessionId);
            await interaction.reply({
                content: 'An error occurred while closing the meeting: session not found.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        const confirmButton = new ButtonBuilder()
            .setCustomId('close-meeting-confirm')
            .setLabel('Confirm')
            .setStyle(ButtonStyle.Success);
        const confirmRow = new ActionRowBuilder().addComponents(confirmButton);
        const replyMessage = await interaction.reply({
            content: 'Are you sure you want to close the meeting?',
            flags: MessageFlags.Ephemeral,
            components: [confirmRow],
        });

        const replyMessageObject = await replyMessage.fetch();
        const confirmMessageId = replyMessageObject.id;
        confirmMsgToSession.set(confirmMessageId, sessionId);
        const timeoutId = setTimeout(async () => {
            await replyMessage.delete();
            confirmMsgToSession.delete(confirmMessageId);
            console.log('End meeting confirm message timed out and deleted.');
        }, 1000 * 60);
        sessionState.timeoutId = timeoutId;

        console.log('End meeting confirm message sent.');
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

    async function startMeeting(interaction) {
        const voiceChannel = interaction.member.voice.channel;

		const interactionResponse = await sendMeetingStartMessage(interaction);

		const replyMessageObject = await interactionResponse.fetch();
		const sessionId = replyMessageObject.id;

		const sessionState = {
            started: false,
            paused: false,
            finished: false,
			participantIds: [],
            rejectedIds: [],
            dmIds: [],
            participantStates: new Map(),
			voiceChannelId: voiceChannel.id,
			originalInteraction: interaction,
			timeoutId: null,
		};
		const sessionTimeoutId = setTimeout(async () => {
			const session = sessionStore.getSessionById(sessionId);
			if (session) {
				await session.originalInteraction.followUp({
					content: 'Session timed out after 1 minute. All participants must accept to start the meeting.',
				});
			}
			sessionStore.deleteSession(sessionId);
			console.log('session timed out and deleted.');
		}, 1000 * 60);
		sessionState.timeoutId = sessionTimeoutId;
		sessionStore.createSession(sessionId, sessionState);

        return true;
    }

    function unsubscribeFromStream(sessionId, participantId) {
        const sessionState = sessionStore.getSessionById(sessionId);
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

    function subscribeToStream(sessionId, participantId) {
        const sessionState = sessionStore.getSessionById(sessionId);
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
            participant.subscription = receiver.subscribe(participantId, options);
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

    async function registerParticipant(sessionId, participantId, interaction) {
        const sessionState = sessionStore.getSessionById(sessionId);
        if (!sessionState) {
            console.error('session not found.', sessionId);
            await interaction.reply({
                content: 'An error occurred while registering you as a participant: session not found.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        if (!sessionState.voiceConnection) {
            if (!(await connectToChannel(sessionId))) {
                throw new Error('error connecting to channel.');
            }
        }
        if (sessionState.timeoutId) {
            clearTimeout(sessionState.timeoutId);
            sessionState.timeoutId = null;
        }

        if (!sessionState.started) {
            const started = await interaction.client.sessionManager.startSession(sessionId);
            if (!started) return false;
            sessionState.started = true;
        }
        sessionState.participantIds.push(participantId);
        const participantState = {
            subscription: null,
            displayName: interaction.user.displayName,
            pcmStream: null,
            chunkerState: {
                samplesBuffer: Buffer.alloc(0),
                samplesInBuffer: 0,
                totalSamplesEmitted: 0,
            }
        };
        sessionState.participantStates.set(participantId, participantState);
        subscribeToStream(sessionId, participantId);
        interaction.client.sessionManager.chunkStream(sessionId, participantId);
        await sessionState.originalInteraction.followUp({
            content: `The user <@${participantId}> has accepted the disclaimer and is included in the meeting recording.`,
        });

        return true;
    }

    function reconnectParticipant(sessionId, participantId) {
        const sessionState = sessionStore.getSessionById(sessionId);
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
            sessionState.originalInteraction.client.sessionManager.chunkStream(sessionId, participantId);
            return true;
        }
        catch (error) {
            console.error('error reconnecting participant.', error);
            return false;
        }
    }

    function stopVoiceCapture(sessionId) {
        const sessionState = sessionStore.getSessionById(sessionId);
        if (!sessionState) {
            console.error('session not found.', sessionId);
            return false;
        }
        try {
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
            throw new Error(error.message);
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
            
                else {await interaction.deferUpdate(); break;}

            case 'disclaimer-reject':
                if (!sessionState.participantIds.includes(userId) && !sessionState.rejectedIds.includes(userId)) {
                    sessionState.rejectedIds.push(userId);
                    await interaction.reply({
                        content: 'Disclaimer rejected. You are not a participant in the meeting and will not be recorded.',
                        flags: MessageFlags.Ephemeral,
                    });

                    console.log('disclaimer rejected and session deleted.');
                    break;
                }
                else {await interaction.deferUpdate(); break;}
        
            case 'close-meeting-confirm':
                try {
                    if (sessionState.timeoutId) {
                        clearTimeout(sessionState.timeoutId);
                        sessionState.timeoutId = null;
                    }
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    stopVoiceCapture(sessionId);
                    const { reportPath, summary } = await interaction.client.sessionManager.closeSession(sessionId);
                    await interaction.editReply({
                        content: `The meeting is over. Thank you for participating.\n\n**Summary:**\n${summary}`,
                    });
                    sessionStore.deleteSession(sessionId);
                    confirmMsgToSession.delete(interaction.message.id);
                    console.log('session deleted.');
                    break;
                } catch (error) {
                    console.error('error closing meeting.', error);
                    await interaction.editReply({
                        content: 'An error occurred while closing the meeting.',
                        flags: MessageFlags.Ephemeral,
                    });
                    break;
                }
            default:
                await interaction.deferUpdate();
                break;
        }
        return true;
    }

    return {
        startMeeting,
        closeMeeting,
        reconnectParticipant,
        handleButtonInteraction,

    };
}
module.exports = { createBotCoordinator };