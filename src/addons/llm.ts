import { Context } from '../interfaces';
import { openai } from "@llamaindex/openai";
import cache from '../cache';

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
    const systemPrompt = `You are a Support Agent. You have been assigned to help
    the user based on the message and only the provided knowledge base. If the knowledge base
    does not contain the information needed to answer the user's question, you should respond
    with "null". Answer truthfully and to the best of your ability. Answer without
    salutation and greetings.\n\n
    Knowledgebase: """
    ${cache.config.llm_knowledge}
    """
    `;

    var response = null
    try {
        response = await getLLM().chat({
            messages: [
                { content: systemPrompt, role: "system" },
                { content: ctx.message.text, role: "user" }
            ],
        });
    }
    catch (error) {
        console.error("Error in LLM response:", error);
        return null;
    }

    const message = response.message.content.toString();
    if (message === "null" || message === "Null" || message === null) {
        return null
    }

    return message;
}

export { getResponseFromLLM };
