require('dotenv').config();
const fs = require('node:fs');

const adapters = {
    ollama: require('./llm-adapters/ollama-adapter.js'),
}

function parseBool(value, defaultValue = false) {
    if (value === undefined || value === null) return defaultValue;
    const normalized = String(value).toLowerCase().trim();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return defaultValue;
}

function parsePositiveInt(value) {
    const n = Number.parseInt(String(value), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function splitIntoChunks(text, maxChars, strategy = 'tail') {
    const normalizedStrategy = String(strategy || 'tail').toLowerCase().trim();
    if (text.length <= maxChars) return [text];

    const chunks = [];
    if (normalizedStrategy === 'tail') {
        for (let end = text.length; end > 0; end -= maxChars) {
            const start = Math.max(0, end - maxChars);
            chunks.push(text.slice(start, end));
        }
        chunks.reverse(); // keep chronological order for combining
        return chunks;
    }

    // default: head (start -> end)
    for (let start = 0; start < text.length; start += maxChars) {
        const end = Math.min(text.length, start + maxChars);
        chunks.push(text.slice(start, end));
    }
    return chunks;
}

function buildSystemPromptDefault() {
    return `
Você é um assistente que resume reuniões em português do Brasil.
Inclua:
1. Até três parágrafos com a ideia geral do que foi discutido, sem necessidade de seções rígidas.
2. Tópicos principais em tópicos (bullets), sem necessidade de seções rígidas.
Seja objetivo. Use no máximo 400 palavras. Use apenas o conteúdo da transcrição.
`.trim();
}

function buildUserPromptDefault(reportText) {
    return `
Resuma a reunião abaixo:

--- TRANSCRIÇÃO ---
${reportText}
--- FIM DA TRANSCRIÇÃO ---
`.trim();
}

function buildSystemPromptChunked() {
    return `
Você é um assistente que resume reuniões em português do Brasil.
A transcrição completa é muito longa e foi dividida em partes. Resuma **somente** a parte recebida, não inclua outras informações.
Regras:
- Escreva em **Markdown**
- Seja objetivo
- Use **no máximo 200 palavras**
- Foque em: decisões, ações (com responsáveis/prazos se aparecerem), riscos e perguntas em aberto
- Se algo não estiver na transcrição desta parte, não mencione
Formato sugerido:
- 1 parágrafo curto de contexto (1–3 frases)
- Depois, bullets com os pontos principais
`.trim();
}

function buildUserPromptChunked(chunkText, partNumber, partCount) {
    return `
Esta é a parte ${partNumber} de ${partCount} da transcrição. Resuma esta parte.

--- TRANSCRIÇÃO (PARTE ${partNumber}/${partCount}) ---
${chunkText}
--- FIM DA PARTE ---
`.trim();
}

function buildSystemPromptCombine() {
    return `
Você é um assistente que resume reuniões em português do Brasil.
Você receberá resumos parciais de uma mesma reunião. Combine-os em um resumo final.
Inclua:
1. Até três parágrafos com a ideia geral do que foi discutido.
2. Tópicos principais em bullets.
Seja objetivo. Use no máximo 400 palavras. Use Markdown.
`.trim();
}

function buildUserPromptCombine(chunkSummaries) {
    return `
Combine os resumos parciais abaixo em um resumo final da reunião.

--- RESUMOS PARCIAIS ---
${chunkSummaries.map((s, i) => `## Parte ${i + 1}\n${String(s || '').trim()}`).join('\n\n')}
--- FIM DOS RESUMOS ---
`.trim();
}

async function generateSummary(reportPath, options = {}) {
    if (!process.env.LLM_PROVIDER) {
        throw new Error('LLM_PROVIDER must be set in .env');
    }

    const adapter = adapters[process.env.LLM_PROVIDER];
    if (!adapter) {
        throw new Error(`Invalid LLM_PROVIDER: ${process.env.LLM_PROVIDER}`);
    }

    const report = fs.readFileSync(reportPath, 'utf8');

    const truncationEnabled = parseBool(process.env.LLM_TRUNCATION_ENABLED, false);
    const maxChars = parsePositiveInt(process.env.LLM_TRUNCATION_MAX_CHARS);
    const strategy = (process.env.LLM_TRUNCATION_STRATEGY || 'tail').trim();

    const shouldTruncate =
        truncationEnabled &&
        maxChars !== null &&
        report.length > maxChars;

    const callLLM = async (system, user) => {
        try {
            return await adapter.complete(system, user, options);
        } catch (error) {
            console.error(`Error calling ${process.env.LLM_PROVIDER}:`, error);
            throw error;
        }
    };

    if (!shouldTruncate) {
        const system = process.env.LLM_SYSTEM_PROMPT
            ? process.env.LLM_SYSTEM_PROMPT
            : buildSystemPromptDefault();
        const user = buildUserPromptDefault(report);
        return await callLLM(system, user);
    }

    const chunks = splitIntoChunks(report, maxChars, strategy);
    const chunkSummaries = [];
    for (let i = 0; i < chunks.length; i++) {
        const system = buildSystemPromptChunked();
        const user = buildUserPromptChunked(chunks[i], i + 1, chunks.length);
        chunkSummaries.push(await callLLM(system, user));
    }

    const system = buildSystemPromptCombine();
    const user = buildUserPromptCombine(chunkSummaries);
    return await callLLM(system, user);
}

module.exports = { generateSummary };
