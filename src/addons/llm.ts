import { Context } from '../interfaces';
import { openai } from "@llamaindex/openai";
import cache from '../cache';
import { sanitizeUserInput, buildSystemPrompt } from './llm-guard';

// Lazily created so that chain-sourced config overrides in cache are applied
// before the first LLM call rather than at module-load time.
let llmInstance: ReturnType<typeof openai> | null = null;

function getLLM() {
    if (!llmInstance) {
        llmInstance = openai({
            model: cache.config.llm_model,
            reasoningEffort: "low",
            apiKey: cache.config.llm_api_key,
            baseURL: cache.config.llm_base_url,
        });
    }
    return llmInstance;
}

async function getResponseFromLLM(ctx: Context): Promise<string | null> {
    const userInput = sanitizeUserInput(ctx.message.text ?? '');
    if (userInput === null) {
        // Detected injection attempt — silently return null so the ticket
        // falls through to a human staff member.
        return null;
    }

    const systemPrompt = buildSystemPrompt(cache.config.llm_knowledge ?? '');

    var response = null;
    try {
        response = await getLLM().chat({
            messages: [
                { content: systemPrompt, role: "system" },
                { content: `<user_message>${userInput}</user_message>`, role: "user" },
            ],
        });
    }
    catch (error) {
        console.error("Error in LLM response:", error);
        return null;
    }

    const message = response.message.content.toString().trim();
    if (/^null$/i.test(message) || message === '') {
        return null;
    }

    return message;
}

export { getResponseFromLLM };
