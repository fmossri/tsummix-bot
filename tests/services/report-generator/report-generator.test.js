const {
    createMinimalTranscriptContent,
    createReadStreamFromString,
} = require('../../helpers/report-test-utils');
const { createReportGenerator } = require('../../../services/report-generator/report-generator.js');

describe('generateReport', () => {
    let mockFs, mockPath, generator;

    beforeEach(() => {
        mockFs = {
            createReadStream: jest.fn(),
            mkdirSync: jest.fn(),
            writeFileSync: jest.fn(),
            readFileSync: jest.fn(),
            renameSync: jest.fn(),
        };
        mockPath = { join: jest.fn((...args) => args.join('/')) };
        generator = createReportGenerator({ fsImpl: mockFs, pathImpl: mockPath });
    });

    it('generates a report from a valid transcript', async () => {
        const transcriptContent = createMinimalTranscriptContent();
        mockFs.createReadStream.mockReturnValue(createReadStreamFromString(transcriptContent));
        const reportPath = await generator.generateReport('any-path');
        expect(mockFs.writeFileSync).toHaveBeenCalled();
        const [path, content] = mockFs.writeFileSync.mock.calls[0];
        expect(path).toMatch(/meeting-report_test-ch-123_.+\.md$/);
        expect(content).toContain('# Transcript for test-transcript-1 on test-ch-123');
        expect(content).toContain('## Participants: Alice, Bob');
        expect(content).toContain('Hello, this is a test segment.');
        expect(content).toContain('Hi Alice, I agree with that.');
    });

    it('returns the report file path', async () => {
        const transcriptContent = createMinimalTranscriptContent();
        mockFs.createReadStream.mockReturnValue(createReadStreamFromString(transcriptContent));
        const reportPath = await generator.generateReport('any-path');
        expect(mockPath.join).toHaveBeenCalled();
        expect(reportPath).toMatch(/meeting-report_test-ch-123_\d{14}\.md$/);
    });

    it('throws when first line is not metadata', async () => {
        const invalidContent = '{"type":"segment","text":"wrong"}\n';
        mockFs.createReadStream.mockReturnValue(createReadStreamFromString(invalidContent));
        await expect(generator.generateReport('any-path')).rejects.toThrow(
            'Invalid transcript file: first line must be type = metadata'
        );
        expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('throws when metadata is incomplete', async () => {
        const invalidContent = '{"type":"metadata","transcriptId":"m1"}\n';
        mockFs.createReadStream.mockReturnValue(createReadStreamFromString(invalidContent));
        await expect(generator.generateReport('any-path')).rejects.toThrow(
            'Invalid transcript file: metadata must contain transcriptId, channelId, meetingStartIso, and participantDisplayNames'
        );
        expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('throws when transcript has no segments (header-only)', async () => {
        const headerOnlyContent = createMinimalTranscriptContent({ segments: [] });
        mockFs.createReadStream.mockReturnValue(createReadStreamFromString(headerOnlyContent));
        await expect(generator.generateReport('any-path')).rejects.toThrow(
            'Transcript has no segments; cannot generate report.'
        );
        expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('skips segment lines with empty text', async () => {
        const transcriptContent = createMinimalTranscriptContent({
            metadata: { type: 'metadata', transcriptId: 'm1', channelId: 'ch1', meetingStartIso: '2025-01-15T14:30:00.000Z', participantDisplayNames: ['Alice'] },
            segments: [
                { transcriptId: 'm1', chunkId: 1, displayName: 'Alice', startMs: 0, endMs: 1000, text: '  ' },
                { transcriptId: 'm1', chunkId: 2, displayName: 'Alice', startMs: 1000, endMs: 2000, text: 'Real content' },
            ],
        });
        mockFs.createReadStream.mockReturnValue(createReadStreamFromString(transcriptContent));
        await generator.generateReport('any-path');
        const [, content] = mockFs.writeFileSync.mock.calls[0];
        // Don't assert on raw whitespace: the report is fixed-width and contains padding spaces.
        // Instead, assert that the whitespace-only segment text did not get rendered.
        expect(content).not.toContain('| Alice |   ');
        expect(content).toContain('Real content');
    });

    it('includes "Ended at" when metadata has closure.endedAtIso (manual or auto-close)', async () => {
        const transcriptContent = createMinimalTranscriptContent({
            metadata: {
                type: 'metadata',
                transcriptId: 't1',
                channelId: 'ch1',
                meetingStartIso: '2025-01-15T14:30:00.000Z',
                participantDisplayNames: ['Alice'],
                closure: { endedAtIso: '2025-01-15T15:45:00.000Z' },
            },
        });
        mockFs.createReadStream.mockReturnValue(createReadStreamFromString(transcriptContent));
        await generator.generateReport('any-path');
        const [, content] = mockFs.writeFileSync.mock.calls[0];
        expect(content).toMatch(/Ended at \d{2}:\d{2}:\d{2}\./);
        expect(content).not.toContain('Reason:');
        expect(content).not.toContain('Meeting ended automatically');
    });

    it('adds reason and partial note when closure.autoClose is true', async () => {
        const transcriptContent = createMinimalTranscriptContent({
            metadata: {
                type: 'metadata',
                transcriptId: 't1',
                channelId: 'ch1',
                meetingStartIso: '2025-01-15T14:30:00.000Z',
                participantDisplayNames: ['Alice'],
                closure: { endedAtIso: '2025-01-15T15:45:00.000Z', autoClose: true, reason: 'inactivity' },
            },
        });
        mockFs.createReadStream.mockReturnValue(createReadStreamFromString(transcriptContent));
        await generator.generateReport('any-path');
        const [, content] = mockFs.writeFileSync.mock.calls[0];
        expect(content).toMatch(/Ended at \d{2}:\d{2}:\d{2}\./);
        expect(content).toContain('Reason: inactivity.');
        expect(content).toContain('Report may be partial; see gap markers below.');
    });
});

describe('insertSummary', () => {
    it('inserts a Summary section immediately before ```text and overwrites report', async () => {
        const mockFs = {
            readFileSync: jest.fn(),
            writeFileSync: jest.fn(),
            renameSync: jest.fn(),
        };
        const generator = createReportGenerator({ fsImpl: mockFs, pathImpl: { join: jest.fn() } });
        const reportPath = '/tmp/report.md';
        const original = [
            '# Transcript for m1 on ch1 at 01 January 2025, 00:00:00',
            '## Participants: Alice',
            '```text',
            ' 00:00:00 | Alice | hello',
            '```',
        ].join('\n');
        mockFs.readFileSync.mockReturnValue(original);

        await generator.insertSummary(reportPath, 'This is the summary.');

        expect(mockFs.writeFileSync).toHaveBeenCalledWith(
            `${reportPath}.tmp`,
            expect.stringContaining('## Summary'),
            'utf8'
        );
        const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
        const summaryIdx = writtenContent.indexOf('## Summary');
        const fenceIdx = writtenContent.indexOf('```text');
        expect(summaryIdx).toBeGreaterThan(-1);
        expect(fenceIdx).toBeGreaterThan(-1);
        expect(summaryIdx).toBeLessThan(fenceIdx);
        expect(writtenContent).toContain('This is the summary.');
        expect(mockFs.renameSync).toHaveBeenCalledWith(`${reportPath}.tmp`, reportPath);
    });

    it('throws if report does not contain a ```text code fence', async () => {
        const mockFs = {
            readFileSync: jest.fn().mockReturnValue('# header only\nno fence\n'),
            writeFileSync: jest.fn(),
            renameSync: jest.fn(),
        };
        const generator = createReportGenerator({ fsImpl: mockFs, pathImpl: { join: jest.fn() } });
        await expect(generator.insertSummary('/tmp/report.md', 'summary')).rejects.toThrow(
            'Report format error: could not find ```text code fence'
        );
        expect(mockFs.writeFileSync).not.toHaveBeenCalled();
        expect(mockFs.renameSync).not.toHaveBeenCalled();
    });
});
