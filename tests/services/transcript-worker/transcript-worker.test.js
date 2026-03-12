const { createTranscriptWorker } = require('../../../services/transcript-worker/transcript-worker');
const { createChunk } = require('../../helpers/test-utils');

let mockFetch, mockFs, mockPath, worker;
beforeEach(() => {
    jest.clearAllMocks();
    mockFs = {
        promises: {
            mkdir: jest.fn().mockResolvedValue(undefined),
            writeFile: jest.fn().mockResolvedValue(undefined),
            appendFile: jest.fn().mockResolvedValue(undefined),
            readFile: jest.fn().mockResolvedValue(''),
            unlink: jest.fn().mockResolvedValue(undefined),
        }
    };
    mockPath = { join: jest.fn((...args) => args.join('/')) };

    mockFetch = jest.fn();
    mockFetch.mockImplementation((url, options) => {
        const body = JSON.parse(options.body);
        return Promise.resolve({
            status: 200,
            json: () => Promise.resolve({
                chunkId: body.chunkId,
                segments: [{ startMs: 0, endMs: 1000, text: 'transcribed' }]
            })
        });
    });

    worker = createTranscriptWorker({
        sttBaseUrl: 'http://localhost:8000',
        fetchImpl: mockFetch,
        fsImpl: mockFs,
        pathImpl: mockPath,
    });
});

describe('startTranscript', () => {
    it('starts a transcript', async () => {
        const transcriptPath = await worker.startTranscript('test-transcript');
        expect(transcriptPath).toMatch(/\.jsonl$/);
        expect(mockFs.promises.mkdir).toHaveBeenCalledWith(expect.stringContaining('transcripts'), { recursive: true });
    });

    it('writes metadata header with channelId and participantDisplayNames', async () => {
        await worker.startTranscript('transcript-1');
        await worker.closeTranscript('transcript-1', {
            channelId: 'ch-123',
            participantDisplayNames: ['Alice', 'Bob']
        });
        expect(mockFs.promises.writeFile).toHaveBeenCalled();
        const [, content] = mockFs.promises.writeFile.mock.calls[0];
        const header = JSON.parse(content.trim());
        expect(header).toMatchObject({
            type: 'metadata',
            transcriptId: 'transcript-1',
            channelId: 'ch-123',
            participantDisplayNames: ['Alice', 'Bob']
        });
    });

    it('throws when mkdir fails', async () => {
        mockFs.promises.mkdir.mockRejectedValue(new Error('Permission denied'));
        await expect(worker.startTranscript('transcript-1')).rejects.toThrow('Permission denied');
    });

    it('throws when writeFile fails on close', async () => {
        await worker.startTranscript('transcript-1');
        mockFs.promises.writeFile.mockRejectedValue(new Error('Permission denied'));
        await expect(worker.closeTranscript('transcript-1')).rejects.toThrow('Permission denied');
    });

    it('uses meetingStartTimeMs for meetingStartIso and filename when valid number', async () => {
        const fixedTimestamp = 1700000000000;
        await worker.startTranscript('transcript-1', fixedTimestamp);
        await worker.closeTranscript('transcript-1', {
            channelId: 'ch-1',
            participantDisplayNames: ['Alice'],
        });
        const [, headerContent] = mockFs.promises.writeFile.mock.calls[0];
        const header = JSON.parse(headerContent.trim());
        expect(header.meetingStartIso).toBe(new Date(fixedTimestamp).toISOString());
    });

    it('falls back to Date.now() when meetingStartTimeMs is not a number', async () => {
        const pathUndefined = await worker.startTranscript('transcript-undefined');
        expect(pathUndefined).toMatch(/\.jsonl$/);

        const pathNull = await worker.startTranscript('transcript-null', null);
        expect(pathNull).toMatch(/\.jsonl$/);
    });
});

describe('enqueueChunk', () => {
    it('throws when transcript not found', async () => {
        await expect(worker.enqueueChunk('test-transcript', createChunk())).rejects.toThrow('Invariant: transcript not found in enqueueChunk');
    });

    it('throws when chunkId is not a number', async () => {
        await worker.startTranscript('test-transcript');
        await expect(worker.enqueueChunk('test-transcript', createChunk({ chunkId: 'not-a-number' }))).rejects.toThrow('Chunk ID must be a number');
    });

    it('throws when chunk has no participantData', async () => {
        await worker.startTranscript('test-transcript');
        await expect(worker.enqueueChunk('test-transcript', createChunk({ participantData: null }))).rejects.toThrow('Chunk has no participantData');
    });

    it('throws when wav is invalid', async () => {
        await worker.startTranscript('test-transcript');
        await expect(worker.enqueueChunk('test-transcript', createChunk({ audio: Buffer.from('invalid-audio') }))).rejects.toThrow('Invalid WAV buffer; must be mono 16kHz PCM');
    });

    it('enqueues a chunk', async () => {
        await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk());
        expect(mockFetch).toHaveBeenCalled();
    });

    it('calls STT with correct URL and body', async () => {
        await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 42, chunkStartTimeMs: 100 }));
        expect(mockFetch).toHaveBeenCalledWith(
            'http://localhost:8000/transcribe',
            expect.objectContaining({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: expect.stringContaining('"chunkId":42'),
            })
        );
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body).toMatchObject({
            transcriptId: 'test-transcript',
            chunkId: 42,
            chunkStartTimeMs: 100,
        });
        expect(body.audio).toBeDefined();
    });

    it('processes multiple chunks in order', async () => {
        await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 1, participantData: { participantId: 'u1', displayName: 'Alice' } }));
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 2, participantData: { participantId: 'u2', displayName: 'Bob' } }));
        await worker.closeTranscript('test-transcript');
        expect(mockFetch).toHaveBeenCalledTimes(2);
        // appendFile: 2 segment lines to tmp, then 1 merge (tmp content → transcript) in closeTranscript
        const segmentCalls = mockFs.promises.appendFile.mock.calls.filter(c => c[0].endsWith('.tmp'));
        expect(segmentCalls.length).toBe(2);
        expect(JSON.parse(segmentCalls[0][1])).toMatchObject({ chunkId: 1, participantId: 'u1', displayName: 'Alice' });
        expect(JSON.parse(segmentCalls[1][1])).toMatchObject({ chunkId: 2, participantId: 'u2', displayName: 'Bob' });
    });

    it('writes clockTimeMs when chunk has chunkClockTimeMs', async () => {
        mockFetch.mockImplementation((url, options) => {
            const body = JSON.parse(options.body);
            return Promise.resolve({
                status: 200,
                json: () => Promise.resolve({
                    chunkId: body.chunkId,
                    segments: [{ startMs: 500, endMs: 1500, text: 'transcribed' }],
                }),
            });
        });
        await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk({
            chunkId: 1,
            chunkClockTimeMs: 10000,
            chunkStartTimeMs: 0,
        }));
        await worker.closeTranscript('test-transcript');
        const segmentCalls = mockFs.promises.appendFile.mock.calls.filter((c) => c[0].endsWith('.tmp'));
        expect(segmentCalls.length).toBeGreaterThan(0);
        const segmentLine = JSON.parse(segmentCalls[0][1]);
        expect(segmentLine.clockTimeMs).toBe(10500);
    });

    it('writes clockTimeMs null when chunk has no chunkClockTimeMs', async () => {
        await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 1 }));
        await worker.closeTranscript('test-transcript');
        const segmentCalls = mockFs.promises.appendFile.mock.calls.filter((c) => c[0].endsWith('.tmp'));
        expect(segmentCalls.length).toBeGreaterThan(0);
        const segmentLine = JSON.parse(segmentCalls[0][1]);
        expect(segmentLine.clockTimeMs).toBeNull();
    });

    it('retries STT on non-200 and succeeds when processing is triggered again', async () => {
        let callCount = 0;
        mockFetch.mockImplementation((url, options) => {
            callCount++;
            const body = JSON.parse(options.body);
            if (callCount === 1) {
                return Promise.resolve({ status: 500, json: () => Promise.resolve({}) });
            }
            return Promise.resolve({
                status: 200,
                json: () => Promise.resolve({
                    chunkId: body.chunkId,
                    segments: [{ startMs: 0, endMs: 1000, text: 'transcribed after retry' }]
                })
            });
        });
        await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 1 }));
        await new Promise(r => setImmediate(r));
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 2 }));
        await worker.closeTranscript('test-transcript');
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(mockFs.promises.appendFile).toHaveBeenCalledWith(
            expect.any(String),
            expect.stringContaining('transcribed after retry')
        );
    });
});

describe('closeTranscript', () => {
    it('throws when transcript not found', async () => {
        await expect(worker.closeTranscript('test-transcript')).rejects.toThrow('Transcript not found');
    });

    it('returns the transcript path', async () => {
        await worker.startTranscript('test-transcript');
        const transcriptPath = await worker.closeTranscript('test-transcript');
        expect(mockFs.promises.writeFile).toHaveBeenCalled();
        const [writeFilePath] = mockFs.promises.writeFile.mock.calls[0];
        expect(transcriptPath).toBe(writeFilePath);
    });

    it('removes the transcript from the map', async () => {
        await worker.startTranscript('test-transcript');
        await worker.closeTranscript('test-transcript');
        await expect(worker.enqueueChunk('test-transcript', createChunk())).rejects.toThrow('Invariant: transcript not found in enqueueChunk');
    });

    it('retries failed chunks on close', async () => {
        let callCount = 0;
        mockFetch.mockImplementation((url, options) => {
            callCount++;
            const body = JSON.parse(options.body);
            if (callCount <= 3) {
                return Promise.resolve({ status: 500, json: () => Promise.resolve({}) });
            }
            return Promise.resolve({
                status: 200,
                json: () => Promise.resolve({
                    chunkId: body.chunkId,
                    segments: [{ startMs: 0, endMs: 1000, text: 'transcribed after close retry' }]
                })
            });
        });
        await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 1 }));
        await new Promise(r => setImmediate(r));
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 2 }));
        await new Promise(r => setImmediate(r));
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 3 }));
        const transcriptPath = await worker.closeTranscript('test-transcript');
        expect(mockFetch).toHaveBeenCalledTimes(6);
        // closeTranscript appends segment content (from tmp) to final transcript path; mock readFile returns '' so we only assert path
        expect(mockFs.promises.appendFile).toHaveBeenCalledWith(transcriptPath, expect.any(String));
    });

    it('waits for queued chunks to be transcribed and flushed before returning', async () => {
        await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk());
        // closeTranscript awaits processingPromise before returning; if it didn't, it could return
        // before processNextChunk finishes and appendFile would not have been called yet.
        const transcriptPath = await worker.closeTranscript('test-transcript');
        // Segment is written to tmp, then closeTranscript appends tmp content to transcript path (mock readFile returns '').
        const mergeCall = mockFs.promises.appendFile.mock.calls.find(c => c[0] === transcriptPath);
        expect(mergeCall).toBeDefined();
        expect(mergeCall[0]).toBe(transcriptPath);
    });
});