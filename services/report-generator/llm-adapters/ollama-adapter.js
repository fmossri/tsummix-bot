require('dotenv').config();

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'phi3:mini';

/**
 * Call Ollama's /api/chat with system + user prompts.
 * @param {string} system - System prompt (role/behavior)
 * @param {string} user - User prompt (transcript or content to process)
 * @param {object} [options] - Optional overrides: model, temperature
 * @returns {Promise<string>} - The assistant's response content
 */
async function complete(system, user, options = {}) {
    const model = options.model || OLLAMA_MODEL;
    const messages = [];

    if (system && system.trim()) {
        messages.push({ role: 'system', content: system.trim() });
    }
    messages.push({ role: 'user', content: user.trim() });

    const body = {
        model,
        messages,
        stream: false,
    };

    if (options.temperature != null) {
        body.options = { temperature: options.temperature };
    } else if (process.env.LLM_TEMPERATURE != null) {
        const t = parseFloat(process.env.LLM_TEMPERATURE);
        if (Number.isFinite(t)) body.options = { temperature: t };
    }

    const url = `${OLLAMA_BASE_URL}/api/chat`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ollama API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    const content = data?.message?.content;
    if (content == null) {
        throw new Error('Ollama response missing message.content');
    }
    return content;
}

module.exports = { complete };
