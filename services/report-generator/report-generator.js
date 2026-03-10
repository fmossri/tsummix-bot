const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

function createReportGenerator({ fsImpl = fs, pathImpl = path } = {}) {

    function formatReportLine(stringsObject, widthsObject, report) {
        let { timeString, nameString, textString } = stringsObject;
        const { timeColumnWidth, nameColumnWidth, textColumnWidth } = widthsObject;
        const namePad = nameColumnWidth - nameString.length - 1;

        if (textString.length > textColumnWidth) {
            const firstLineText = textString.slice(0, textColumnWidth);
            textString = textString.slice(textColumnWidth);
            const firstLine = `${' '}${timeString}${' '}|${' '}${nameString}${' '.repeat(namePad)}|${' '}${firstLineText}`;
            report.push(firstLine);
            while (textString.length > textColumnWidth) {
                let lineText;
                if (textString[textColumnWidth] === ' ') {
                    lineText = textString.slice(0, textColumnWidth);
                    textString = textString.slice(textColumnWidth);
                }
                else {
                    lineText = textString.slice(0, textColumnWidth - 1) + '-';
                    textString = textString.slice(textColumnWidth - 1);
                }
                const line = `${' '}${' '.repeat(timeColumnWidth)}|${' '.repeat(nameColumnWidth)}|${' '}${lineText}`;
                report.push(line);
            }
            if (textString.length > 0) {
                const lastLine = `${' '}${' '.repeat(timeColumnWidth)}|${' '.repeat(nameColumnWidth)}|${' '}${textString}`;
                report.push(lastLine);
            }
        }
        else {
            const lineText = textString;
            const line = `${' '}${timeString}${' '}|${' '}${nameString}${' '.repeat(namePad)}|${' '}${lineText}`;
            report.push(line);
        }
    }

    async function generateReport(transcriptPath) {
        try {
            let report = [];
            const textStream = fsImpl.createReadStream(transcriptPath);
            const rl = readline.createInterface({input: textStream, crlfDelay: Infinity});
        let ifFirstLine = true;
        let sessionId = null;
        let channelId = null;
        let meetingStartIso = null;
        let participantDisplayNames = [];
        let reportPath = null;
        let timeColumnWidth = null;
        let nameColumnWidth = null;
        let textColumnWidth = null;
        for await (const line of rl) {
            if (!line.trim()) {
                continue;
            }
            const JSONLine = JSON.parse(line);
            if (ifFirstLine) {
                if (JSONLine.type !== 'metadata') {
                    throw new Error(`Invalid transcript file: first line must be type = metadata`);
                }
                
                sessionId = JSONLine.meetingId;
                channelId = JSONLine.channelId;
                meetingStartIso = JSONLine.meetingStartIso;
                participantDisplayNames = JSONLine.participantDisplayNames;
                if (!sessionId || !channelId || !meetingStartIso || !participantDisplayNames?.length) {
                    throw new Error(`Invalid transcript file: metadata must contain meetingId, channelId, meetingStartIso, and participantDisplayNames (with at least one participant)`);
                }
                timeColumnWidth = " hh:mm:ss ".length;
                nameColumnWidth = Math.max(...participantDisplayNames.map(name => name.length)) + 2;
                textColumnWidth = 69 - timeColumnWidth - nameColumnWidth;
                const projectRoot = pathImpl.join(__dirname, '..', '..');
    
                fsImpl.mkdirSync(pathImpl.join(projectRoot, 'reports'), { recursive: true });
                const reportPathDate = meetingStartIso.slice(0, -5).replace(/\D/g, '');
                reportPath = pathImpl.join(projectRoot, 'reports', `meeting-report_${channelId}_${reportPathDate}.md`);

                const dateTimeStr = new Date(meetingStartIso).toLocaleString('en-GB', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric', 
                    hour: '2-digit', 
                    minute: '2-digit', 
                    second: '2-digit', 
                    hour12: false 
                });
                report.push(`# Transcript for ${sessionId} on ${channelId} at ${dateTimeStr}`);
                report.push(`## Participants: ${participantDisplayNames.join(', ')}`);
                report.push('```text');

                ifFirstLine = false;
                continue;
            }
            if (!JSONLine.text?.trim()) {
                continue;
            }
            const timestampMs = typeof JSONLine.clockTimeMs === 'number'
                ? JSONLine.clockTimeMs
                : null;
            const timeString = timestampMs === null
                ? '00:00:00'
                : new Date(timestampMs).toLocaleTimeString('pt-BR', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                });
            const stringsToFormat = {
                timeString: timeString,
                nameString: JSONLine.displayName ?? 'Undefined',
                textString: JSONLine.text,
            };
            const columnWidths = {
                timeColumnWidth: timeColumnWidth,
                nameColumnWidth: nameColumnWidth,
                textColumnWidth: textColumnWidth,
            };
            formatReportLine(stringsToFormat, columnWidths, report);
        }

        report.push('```');
        fsImpl.writeFileSync(reportPath, report.join('\n'), 'utf8');
        return reportPath;
        } catch (error) {
            console.error('Error generating report:', error);
            throw error;
        }
    }

    async function insertSummary(reportPath, summaryText) {
        const readFile =
            fsImpl?.promises?.readFile
                ? fsImpl.promises.readFile.bind(fsImpl.promises)
                : (p, enc) => Promise.resolve(fsImpl.readFileSync(p, enc));
        const writeFile =
            fsImpl?.promises?.writeFile
                ? fsImpl.promises.writeFile.bind(fsImpl.promises)
                : (p, content, enc) => Promise.resolve(fsImpl.writeFileSync(p, content, enc));
        const rename =
            fsImpl?.promises?.rename
                ? fsImpl.promises.rename.bind(fsImpl.promises)
                : (from, to) => Promise.resolve(fsImpl.renameSync(from, to));

        const markdown = await readFile(reportPath, 'utf8');
        const lines = markdown.split('\n');
        const codeFenceIdx = lines.findIndex((l) => l.trim() === '```text');
        if (codeFenceIdx === -1) {
            throw new Error('Report format error: could not find ```text code fence');
        }

        const summaryLines = String(summaryText ?? '').trim().length
            ? String(summaryText).trim().split('\n')
            : ['(No summary)'];

        const updatedLines = [
            ...lines.slice(0, codeFenceIdx),
            '## Summary',
            '',
            ...summaryLines,
            '',
            ...lines.slice(codeFenceIdx),
        ];

        const tempPath = `${reportPath}.tmp`;
        await writeFile(tempPath, updatedLines.join('\n'), 'utf8');
        await rename(tempPath, reportPath);
    }

    return { generateReport, insertSummary };
}

module.exports = { createReportGenerator };