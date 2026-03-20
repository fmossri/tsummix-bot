jest.mock('../../../services/logger/logger', () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

jest.mock('../../../services/metrics/metrics', () => ({
    increment: jest.fn(),
    incrementGauge: jest.fn(),
    set: jest.fn(),
    observe: jest.fn(),
}));

const logger = require('../../../services/logger/logger');
const { createTranscriptWorker } = require('../../../services/transcript-worker/transcript-worker');
const { createChunk } = require('../../helpers/test-utils');

let mockFetch, mockFs, mockPath, worker;
let tmpFileContent;
beforeEach(() => {
    jest.clearAllMocks();
    tmpFileContent = '';
    mockFs = {
        promises: {
            mkdir: jest.fn().mockResolvedValue(undefined),
            writeFile: jest.fn().mockResolvedValue(undefined),
            appendFile: jest.fn().mockImplementation((path, content) => {
                if (String(path).endsWith('.tmp')) tmpFileContent += content;
                return Promise.resolve(undefined);
            }),
            readFile: jest.fn().mockImplementation((path) => {
                if (String(path).endsWith('.tmp')) {
                    if (tmpFileContent === '') {
                        const err = new Error('ENOENT');
                        err.code = 'ENOENT';
                        return Promise.reject(err);
                    }
                    return Promise.resolve(tmpFileContent);
                }
                return Promise.resolve('');
            }),
            unlink: jest.fn().mockResolvedValue(undefined),
        }
    };
    mockPath = { join: jest.fn((...args) => args.join('/')) };

    mockFetch = jest.fn();
    mockFetch.mockImplementation((url, options) => {
        if (String(url).endsWith('/health')) {
            return Promise.resolve({
                status: 200,
                json: () => Promise.resolve({ ready: true }),
            });
        }
        const body = options?.body ? JSON.parse(options.body) : {};
        return Promise.resolve({
            status: 200,
            json: () => Promise.resolve({
                chunkId: body.chunkId,
                segments: [{ startMs: 0, endMs: 1000, text: 'transcribed' }]
            })
        });
    });

    const workerConfig = {
        sttBaseUrl: 'http://localhost:8000',
        workerTimeouts: { sttTimeoutMs: 5000, sttReadyTimeoutMs: 120000, sttReadyPollMs: 2000 },
    };
    worker = createTranscriptWorker({
        workerConfig,
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

    it('throws when closing with no segments (no chunks enqueued)', async () => {
        await worker.startTranscript('test-transcript');
        await expect(worker.closeTranscript('test-transcript')).rejects.toThrow('No transcript segments were produced');
    });

    it('writes metadata header with channelId and participantDisplayNames', async () => {
        await worker.startTranscript('transcript-1');
        await worker.enqueueChunk('transcript-1', createChunk({ chunkId: 1, participantData: { participantId: 'u1', displayName: 'Alice' } }));
        await new Promise(r => setImmediate(r));
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
        await worker.enqueueChunk('transcript-1', createChunk());
        await new Promise(r => setImmediate(r));
        mockFs.promises.writeFile.mockRejectedValue(new Error('Permission denied'));
        await expect(worker.closeTranscript('transcript-1')).rejects.toThrow('Permission denied');
    });

    it('uses meetingStartTimeMs for meetingStartIso and filename when valid number', async () => {
        const fixedTimestamp = 1700000000000;
        await worker.startTranscript('transcript-1', fixedTimestamp);
        await worker.enqueueChunk('transcript-1', createChunk());
        await new Promise(r => setImmediate(r));
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
        await new Promise(r => setImmediate(r));
        const transcribeCalls = mockFetch.mock.calls.filter((c) => String(c[0]).endsWith('/transcribe'));
        expect(transcribeCalls.length).toBeGreaterThan(0);
        expect(transcribeCalls[0][0]).toBe('http://localhost:8000/transcribe');
        expect(transcribeCalls[0][1]).toMatchObject({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        expect(transcribeCalls[0][1].body).toContain('"chunkId":42');
        const body = JSON.parse(transcribeCalls[0][1].body);
        expect(body).toMatchObject({
            transcriptId: 'test-transcript',
            chunkId: 42,
            chunkStartTimeMs: 100,
        });
        expect(body.audio).toBeDefined();
    });

    it('processes multiple chunks in order', async () => {
        await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 0, participantData: { participantId: 'u1', displayName: 'Alice' } }));
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 1, participantData: { participantId: 'u2', displayName: 'Bob' } }));
        await worker.closeTranscript('test-transcript');
        const transcribeCalls = mockFetch.mock.calls.filter((c) => String(c[0]).endsWith('/transcribe'));
        expect(transcribeCalls).toHaveLength(2);
        // appendToTemp writes one appendFile per flush with all segment lines combined (chunkIds 0,1 -> no gap for 0)
        const segmentCalls = mockFs.promises.appendFile.mock.calls.filter(c => String(c[0]).endsWith('.tmp'));
        expect(segmentCalls.length).toBeGreaterThanOrEqual(1);
        const content = segmentCalls[0][1];
        const segmentLines = content.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type !== 'gap');
        expect(segmentLines.length).toBe(2);
        expect(segmentLines[0]).toMatchObject({ chunkId: 0, participantId: 'u1', displayName: 'Alice' });
        expect(segmentLines[1]).toMatchObject({ chunkId: 1, participantId: 'u2', displayName: 'Bob' });
    });

    it('writes clockTimeMs when chunk has chunkClockTimeMs', async () => {
        mockFetch.mockImplementation((url, options) => {
            if (String(url).endsWith('/health')) {
                return Promise.resolve({ status: 200, json: () => Promise.resolve({ ready: true }) });
            }
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
        const content = segmentCalls[0][1];
        const firstLine = content.split('\n').filter(Boolean)[0];
        const segmentLine = JSON.parse(firstLine);
        expect(segmentLine.clockTimeMs).toBe(10500);
    });

    it('writes clockTimeMs null when chunk has no chunkClockTimeMs', async () => {
        await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 1 }));
        await worker.closeTranscript('test-transcript');
        const segmentCalls = mockFs.promises.appendFile.mock.calls.filter((c) => c[0].endsWith('.tmp'));
        expect(segmentCalls.length).toBeGreaterThan(0);
        const content = segmentCalls[0][1];
        const firstLine = content.split('\n').filter(Boolean)[0];
        const segmentLine = JSON.parse(firstLine);
        expect(segmentLine.clockTimeMs).toBeNull();
    });

    it('retries STT on non-200 and succeeds when processing is triggered again', async () => {
        let callCount = 0;
        mockFetch.mockImplementation((url, options) => {
            if (String(url).endsWith('/health')) {
                return Promise.resolve({ status: 200, json: () => Promise.resolve({ ready: true }) });
            }
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
        // One health check + two chunks: first fails then succeeds on retry, second succeeds; expect 1 health + 3 transcribe.
        const transcribeCalls = mockFetch.mock.calls.filter((c) => String(c[0]).endsWith('/transcribe'));
        expect(transcribeCalls).toHaveLength(3);
        expect(mockFs.promises.appendFile).toHaveBeenCalledWith(
            expect.any(String),
            expect.stringContaining('transcribed after retry')
        );
    });

    it('requeues 429 chunk to tail so newer chunk is processed first', async () => {
        const transcribeOrder = [];
        let chunk1Attempts = 0;
        mockFetch.mockImplementation((url, options) => {
            if (String(url).endsWith('/health')) {
                return Promise.resolve({ status: 200, json: () => Promise.resolve({ ready: true }) });
            }
            const body = JSON.parse(options.body);
            transcribeOrder.push(body.chunkId);
            if (body.chunkId === 1) {
                chunk1Attempts++;
                if (chunk1Attempts === 1) {
                    return Promise.resolve({ status: 429, statusText: 'Too Many Requests', json: () => Promise.resolve({}) });
                }
            }
            return Promise.resolve({
                status: 200,
                json: () => Promise.resolve({
                    chunkId: body.chunkId,
                    segments: [{ startMs: 0, endMs: 1000, text: `ok-${body.chunkId}` }]
                })
            });
        });

        await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 1 }));
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 2 }));
        await worker.closeTranscript('test-transcript');

        // If 429 is requeued to tail, expected order is: first attempt on 1, then 2, then retry 1.
        expect(transcribeOrder).toEqual([1, 2, 1]);
    });
});

describe('closeTranscript', () => {
    it('throws when transcript not found', async () => {
        await expect(worker.closeTranscript('test-transcript')).rejects.toThrow('Transcript not found');
    });

    it('returns true on success', async () => {
        await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk());
        const result = await worker.closeTranscript('test-transcript');
        expect(result).toBe(true);
        expect(mockFs.promises.writeFile).toHaveBeenCalled();
    });

    it('removes the transcript from the map', async () => {
        await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk());
        await new Promise(r => setImmediate(r));
        await worker.closeTranscript('test-transcript');
        await expect(worker.enqueueChunk('test-transcript', createChunk())).rejects.toThrow('Invariant: transcript not found in enqueueChunk');
    });

    it('retries failed chunks on close', async () => {
        let callCount = 0;
        mockFetch.mockImplementation((url, options) => {
            if (String(url).endsWith('/health')) {
                return Promise.resolve({ status: 200, json: () => Promise.resolve({ ready: true }) });
            }
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
        await worker.closeTranscript('test-transcript');
        const [writeFilePath] = mockFs.promises.writeFile.mock.calls[0];
        // One health check + three chunks, each failing twice then succeeding: 1 health + 6 transcribe calls.
        const transcribeCalls = mockFetch.mock.calls.filter((c) => String(c[0]).endsWith('/transcribe'));
        expect(transcribeCalls).toHaveLength(6);
        // closeTranscript appends segment content (from tmp) to final transcript path
        expect(mockFs.promises.appendFile).toHaveBeenCalledWith(writeFilePath, expect.any(String));
    });

    it('treats AbortError as timeout and eventually moves chunk to failedChunks', async () => {
        // Simulate AbortError from fetchWithTimeout; decorator sets isSttTimeout=true.
        const abortError = new Error('timeout');
        abortError.name = 'AbortError';
        mockFetch.mockImplementation((url) => {
            if (String(url).endsWith('/health')) {
                return Promise.resolve({ status: 200, json: () => Promise.resolve({ ready: true }) });
            }
            return Promise.reject(abortError);
        });

        await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 1 }));

        // No segments produced (all chunks failed) -> close throws with actionable message.
        await expect(worker.closeTranscript('test-transcript')).rejects.toThrow('No transcript segments were produced');

        // After retries exhausted, we should have logged stt_response_failed with SttTimeout.
        const errorCalls = logger.error.mock.calls.filter(
            (c) => c[1] === 'stt_response_failed'
        );
        expect(errorCalls.length).toBeGreaterThan(0);
        const lastContext = errorCalls[errorCalls.length - 1][3];
        expect(lastContext.errorClass).toBe('SttTimeout');
    });

    it('closes with a partial transcript (segments + gaps) when some chunks fail permanently', async () => {
        mockFetch.mockImplementation((url, options) => {
            if (String(url).endsWith('/health')) {
                return Promise.resolve({ status: 200, json: () => Promise.resolve({ ready: true }) });
            }
            const body = JSON.parse(options.body);
            if (body.chunkId === 2) {
                return Promise.resolve({ status: 500, json: () => Promise.resolve({}) });
            }
            return Promise.resolve({
                status: 200,
                json: () => Promise.resolve({
                    chunkId: body.chunkId,
                    segments: [{ startMs: 0, endMs: 1000, text: `ok-${body.chunkId}` }],
                }),
            });
        });

        await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 1 }));
        await new Promise((r) => setImmediate(r));
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 2 }));
        await new Promise((r) => setImmediate(r));
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 3 }));

        await worker.closeTranscript('test-transcript', {
            channelId: 'ch-123',
            participantDisplayNames: ['Alice'],
        });

        const tmpCalls = mockFs.promises.appendFile.mock.calls.filter((c) => String(c[0]).endsWith('.tmp'));
        const combined = tmpCalls.map((c) => c[1]).join('');
        const lines = combined.split('\n').filter(Boolean).map((l) => JSON.parse(l));

        expect(lines.some((l) => l.type === 'gap' && l.chunkId === 2)).toBe(true);
        expect(lines.some((l) => l.text === 'ok-1')).toBe(true);
        expect(lines.some((l) => l.text === 'ok-3')).toBe(true);

        // Logged clearly: warn includes chunkId list
        const warnCalls = logger.warn.mock.calls.filter((c) => c[1] === 'transcript_closed');
        expect(warnCalls.length).toBeGreaterThan(0);
        const warnContext = warnCalls[warnCalls.length - 1][3];
        expect(warnContext.failedChunkStartTimes).toContain('chunkId 2');
    });

    it('writes explicit gap markers when a chunk still fails after close retry', async () => {
        mockFetch.mockImplementation((url) => {
            if (String(url).endsWith('/health')) {
                return Promise.resolve({ status: 200, json: () => Promise.resolve({ ready: true }) });
            }
            return Promise.resolve({ status: 500, json: () => Promise.resolve({}) });
        });
        await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk({ chunkId: 1 }));
        // All chunks fail STT -> no segments -> close throws with actionable message.
        await expect(worker.closeTranscript('test-transcript')).rejects.toThrow('No transcript segments were produced');
        // Gap marker was still written to tmp before we validated segment count.
        const tmpCalls = mockFs.promises.appendFile.mock.calls.filter((c) => String(c[0]).endsWith('.tmp'));
        const combined = tmpCalls.map((c) => c[1]).join('');
        const lines = combined.split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const gapLine = lines.find((l) => l.type === 'gap' && l.chunkId === 1);
        expect(gapLine).toBeDefined();
        expect(gapLine.displayName).toBeDefined();
        expect(gapLine.text).toContain('Missing transcript for chunk 1');
    });

    it('waits for queued chunks to be transcribed and flushed before returning', async () => {
        const transcriptPath = await worker.startTranscript('test-transcript');
        await worker.enqueueChunk('test-transcript', createChunk());
        // closeTranscript awaits processingPromise before returning; if it didn't, it could return
        // before processNextChunk finishes and appendFile would not have been called yet.
        await worker.closeTranscript('test-transcript');
        // Segment is written to tmp, then closeTranscript appends tmp content to transcript path (mock readFile returns '').
        const mergeCall = mockFs.promises.appendFile.mock.calls.find(c => c[0] === transcriptPath);
        expect(mergeCall).toBeDefined();
        expect(mergeCall[0]).toBe(transcriptPath);
    });

    it('sorts segment content by clockTimeMs (primary) then chunkId when appending to final transcript', async () => {
        const unsortedJsonl = [
            JSON.stringify({ type: 'segment', chunkId: 2, text: 'second', clockTimeMs: 200 }),
            JSON.stringify({ type: 'segment', chunkId: 0, text: 'zeroth', clockTimeMs: 0 }),
            JSON.stringify({ type: 'segment', chunkId: 1, text: 'first', clockTimeMs: 100 }),
        ].join('\n');
        mockFs.promises.readFile.mockResolvedValue(unsortedJsonl);

        const transcriptPath = await worker.startTranscript('test-transcript');
        await worker.closeTranscript('test-transcript', {
            channelId: 'ch-1',
            participantDisplayNames: ['Alice'],
        });

        const appendToPathCalls = mockFs.promises.appendFile.mock.calls.filter((c) => c[0] === transcriptPath);
        expect(appendToPathCalls.length).toBe(1);
        const appendedContent = appendToPathCalls[0][1];
        const lines = appendedContent.split('\n').filter(Boolean).map((l) => JSON.parse(l));
        expect(lines[0].text).toBe('zeroth');
        expect(lines[1].text).toBe('first');
        expect(lines[2].text).toBe('second');
        const chunkIds = lines.map((l) => l.chunkId);
        expect(chunkIds).toEqual([0, 1, 2]);
    });

    it('sorts transcript lines by clockTimeMs then chunkId so gaps appear in correct place', async () => {
        const unsortedWithGap = [
            JSON.stringify({ chunkId: 3, text: 'segment three', type: 'segment' }),
            JSON.stringify({ chunkId: 1, text: 'segment one', type: 'segment' }),
            JSON.stringify({ type: 'gap', chunkId: 2, text: 'Chunk 2 never reached the worker queue', displayName: 'System' }),
        ].join('\n');
        mockFs.promises.readFile.mockResolvedValue(unsortedWithGap);

        const transcriptPath = await worker.startTranscript('test-transcript');
        await worker.closeTranscript('test-transcript');

        const appendToPathCalls = mockFs.promises.appendFile.mock.calls.filter((c) => c[0] === transcriptPath);
        expect(appendToPathCalls.length).toBe(1);
        const appendedContent = appendToPathCalls[0][1];
        const lines = appendedContent.split('\n').filter(Boolean).map((l) => JSON.parse(l));
        expect(lines.length).toBe(3);
        expect(lines.map((l) => l.chunkId)).toEqual([1, 2, 3]);
        expect(lines[1].type).toBe('gap');
        expect(lines[1].text).toContain('never reached');
    });

    it('sorts by clockTimeMs first; lines with null clockTimeMs sort after numeric ones', async () => {
        const sameChunkWithNull = [
            JSON.stringify({ type: 'segment', chunkId: 1, text: 'first', clockTimeMs: 100 }),
            JSON.stringify({ type: 'segment', chunkId: 1, text: 'middle', clockTimeMs: null }),
            JSON.stringify({ type: 'segment', chunkId: 1, text: 'last', clockTimeMs: 200 }),
        ].join('\n');
        mockFs.promises.readFile.mockResolvedValue(sameChunkWithNull);

        const transcriptPath = await worker.startTranscript('test-transcript');
        await worker.closeTranscript('test-transcript');

        const appendToPathCalls = mockFs.promises.appendFile.mock.calls.filter((c) => c[0] === transcriptPath);
        expect(appendToPathCalls.length).toBe(1);
        const appendedContent = appendToPathCalls[0][1];
        const lines = appendedContent.split('\n').filter(Boolean).map((l) => JSON.parse(l));
        expect(lines.length).toBe(3);
        expect(lines[0].text).toBe('first');
        expect(lines[1].text).toBe('last');
        expect(lines[2].text).toBe('middle');
    });
});