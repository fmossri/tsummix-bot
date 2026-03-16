const { createWorkerHttpClient } = require('../../../services/transcript-worker/http-client');

describe('createWorkerHttpClient', () => {
	const workerBaseUrl = 'http://localhost:3000';
	const workerConfig = { workerBaseUrl };

	describe('startTranscript', () => {
		it('POSTs to /start-transcript and returns transcriptPath when response is ok', async () => {
			const transcriptPath = '/path/to/transcript.jsonl';
			const mockFetch = jest.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ started: true, transcriptPath }),
			});
			const client = createWorkerHttpClient(workerConfig, mockFetch);

			const result = await client.startTranscript('transcript-1', 1700000000000);

			expect(result).toBe(transcriptPath);
			expect(mockFetch).toHaveBeenCalledTimes(1);
			expect(mockFetch).toHaveBeenCalledWith(
				`${workerBaseUrl}/start-transcript`,
				expect.objectContaining({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ transcriptId: 'transcript-1', meetingStartTimeMs: 1700000000000 }),
				})
			);
		});

		it('throws when response is not ok', async () => {
			const mockFetch = jest.fn().mockResolvedValue({ ok: false, statusText: 'Bad Request' });
			const client = createWorkerHttpClient(workerConfig, mockFetch);

			await expect(client.startTranscript('transcript-1')).rejects.toThrow('Failed to start transcript: Bad Request');
		});
	});

	describe('enqueueChunk', () => {
		it('POSTs to /enqueue-chunk with transcriptId and chunk (audio as base64) and returns true when ok', async () => {
			const audioBuffer = Buffer.from([0, 1, 2, 3]);
			const chunk = {
				chunkId: 1,
				participantData: { participantId: 'u1', displayName: 'Alice' },
				chunkStartTimeMs: 0,
				audio: audioBuffer,
			};
			const mockFetch = jest.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ ok: true }),
			});
			const client = createWorkerHttpClient(workerConfig, mockFetch);

			const result = await client.enqueueChunk('transcript-1', chunk);

			expect(result).toBe(true);
			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [url, options] = mockFetch.mock.calls[0];
			expect(url).toBe(`${workerBaseUrl}/enqueue-chunk`);
			expect(options.method).toBe('POST');
			expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
			const body = JSON.parse(options.body);
			expect(body.transcriptId).toBe('transcript-1');
			expect(body.chunk).toBeDefined();
			expect(body.chunk.audio).toBe(audioBuffer.toString('base64'));
			expect(body.chunk.chunkId).toBe(1);
			expect(chunk.audio).toBe(audioBuffer);
		});

		it('does not mutate the original chunk', async () => {
			const audioBuffer = Buffer.from([4, 5, 6]);
			const chunk = { chunkId: 2, audio: audioBuffer };
			const mockFetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
			const client = createWorkerHttpClient(workerConfig, mockFetch);

			await client.enqueueChunk('t1', chunk);

			expect(chunk.audio).toBe(audioBuffer);
		});

		it('throws when response is not ok', async () => {
			const mockFetch = jest.fn().mockResolvedValue({ ok: false, statusText: 'Internal Server Error' });
			const client = createWorkerHttpClient(workerConfig, mockFetch);

			await expect(client.enqueueChunk('t1', { chunkId: 1, audio: Buffer.alloc(0) })).rejects.toThrow(
				'Failed to enqueue chunk: Internal Server Error'
			);
		});
	});

	describe('closeTranscript', () => {
		it('POSTs to /close-transcript with transcriptId and options and returns true when ok', async () => {
			const mockFetch = jest.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ ok: true }),
			});
			const client = createWorkerHttpClient(workerConfig, mockFetch);

			const result = await client.closeTranscript('transcript-1', {
				channelId: 'ch-123',
				participantDisplayNames: ['Alice', 'Bob'],
				closure: { endedAtIso: '2024-01-01T12:00:00.000Z' },
			});

			expect(result).toBe(true);
			expect(mockFetch).toHaveBeenCalledWith(
				`${workerBaseUrl}/close-transcript`,
				expect.objectContaining({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						transcriptId: 'transcript-1',
						channelId: 'ch-123',
						participantDisplayNames: ['Alice', 'Bob'],
						closure: { endedAtIso: '2024-01-01T12:00:00.000Z' },
					}),
				})
			);
		});

		it('accepts empty options', async () => {
			const mockFetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
			const client = createWorkerHttpClient(workerConfig, mockFetch);

			await client.closeTranscript('transcript-1');

			const body = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(body.transcriptId).toBe('transcript-1');
		});

		it('throws when response is not ok', async () => {
			const mockFetch = jest.fn().mockResolvedValue({ ok: false, statusText: 'Not Found' });
			const client = createWorkerHttpClient(workerConfig, mockFetch);

			await expect(client.closeTranscript('transcript-1')).rejects.toThrow('Failed to close transcript: Not Found');
		});
	});
});
