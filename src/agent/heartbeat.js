import { extractJsonObjectText } from '../llm/json.js';

export function createHeartbeatAgent({ client, modelSelector }) {
  return {
    async analyzeProject(context) {
      const model = modelSelector.select('planner');
      const soul =
        typeof context.soulContext === 'string' && context.soulContext.trim().length > 0
          ? `## Core Identity and Guidelines:\n${context.soulContext.trim()}`
          : '';

      const prompt = `You are the LocalClaw Project Overseer. 

${soul}

Your job is to proactively scan the current state of the workspace and identify if any maintenance, security, or architectural tasks are needed.

Current Workspace Snapshot:
${context.workspaceSnapshot}

Recent Learnings:
${context.recentLearnings}

Available Tools:
${context.toolCatalog}

Instructions:
1. Look for "Dependency Drift" (outdated packages).
2. Look for "Documentation Rot" (stale READMEs).
3. Look for "Security Risks" (secrets in code, weak patterns).
4. Look for "Code Quality" (TODO clusters, obvious refactoring needs).

If you find something important, propose a NEW task.
Respond ONLY with a JSON array of task objects, or an empty array [] if nothing is urgent.

Format:
[
  {
    "title": "Short descriptive title",
    "description": "Detailed explanation of why this task is needed and what to do.",
    "priority": "low" | "medium" | "high" | "critical"
  }
]`;

      const response = await client.generate({
        model,
        prompt,
        format: 'json',
        options: { temperature: 0.2 }
      });

      try {
        const jsonText = extractJsonObjectText(response.responseText);
        return JSON.parse(jsonText);
      } catch (error) {
        return [];
      }
    }
  };
}
