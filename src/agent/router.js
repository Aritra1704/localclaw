import { extractJsonObjectText } from '../llm/ollama.js';

export function createDynamicRouter({ client, modelSelector }) {
  return {
    async classifyTask(task) {
      const prompt = `You are the LocalClaw Task Router.
Analyze the user's request and categorize it to assign the most efficient LLM actor.

Available Roles:
- planner (gemma/llama - good for heavy architecture, database design, complex planning)
- coder (qwen2.5-coder - good for pure programming, syntax, refactoring, writing scripts)
- fast (qwen2.5-instruct - good for simple chitchat, readme updates, quick text generation)

Task Title: ${task.title}
Task Description: ${task.description}

Return ONLY a JSON object with this format:
{"role": "coder", "reason": "Task involves writing python code."}`;

      try {
        const response = await client.generate({
          model: modelSelector.select('fast'), // Use the fast model for routing
          prompt,
          format: 'json',
          temperature: 0.1,
        });

        const jsonText = extractJsonObjectText(response.responseText);
        const parsed = JSON.parse(jsonText);

        if (['planner', 'coder', 'fast'].includes(parsed.role)) {
          return parsed.role;
        }
        return 'planner'; // Fallback
      } catch (error) {
        return 'planner'; // Fallback on network or parse error
      }
    }
  };
}
