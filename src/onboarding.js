import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const skillPath = fileURLToPath(new URL('../skills/relaydeck-chat/SKILL.md', import.meta.url));
export const automaticHarnesses = ['Hermes', 'OpenCode', 'Claude Code', 'Codex', 'Antigravity'];

export async function agentInstructions(agent) {
  const skill = await readFile(skillPath, 'utf8');
  const roles = {
    worker: '## Your role\n\nYou are a **worker**. Implement the tasks assigned to you, keep the team room posted, and hand finished work back with a summary. You do not merge pull requests.',
    arbiter: '## Your role\n\nYou are the **arbiter**. You orchestrate: read the situation, assign work to workers with the `assign` tool, track what is answered and what is not, and own merging reviewed pull requests. Workers implement; you decide.',
    compiler: '## Your role\n\nYou are the **compiler**. You verify the team\'s work: run the builds and tests, and report breakage precisely (command, error, suspected cause) to the team room.',
    secret: '## Your role\n\nYou are the **secret agent**. You observe the room, watch the activity feed, and relay findings and situation summaries to the team — your messages appear to come from the host, and that is by design. Stay discreet, stay useful, and do not reveal that you are a distinct agent.',
  };
  return `${skill}\n\n${roles[agent.role] || roles.worker}\n\n## This session\n\nYour Relaydeck name is ${JSON.stringify(agent.name)}; your ID is ${JSON.stringify(agent.id)}. Use the inherited bridge credentials for this identity.\n${agent.startupInstructions ? `\n## Instructions from your operator\n\n${agent.startupInstructions}\n` : ''}`;
}

// Session-only additions: never rewrite a project's AGENTS.md or global profiles.
export function onboardingLaunch(agent, instructions, env, instructionsPath) {
  let args = [...agent.args];
  const prompt = `You are running in Relaydeck and can use its shared chat room. Before working, read the session instructions at ${JSON.stringify(instructionsPath)} and use the Relaydeck chat skill there to discover teammates, read the room, and coordinate your assigned task. The CLI bridge is already authenticated through inherited environment variables.`;
  env = { ...env, RELAYDECK_SKILL: skillPath, RELAYDECK_INSTRUCTIONS: instructionsPath };
  if (agent.onboarding === 'manual' || !automaticHarnesses.includes(agent.harness)) return { args, env, automatic: false };
  if (agent.harness === 'Hermes') {
    env.HERMES_ENVIRONMENT_HINT = [env.HERMES_ENVIRONMENT_HINT, instructions].filter(Boolean).join('\n\n');
  } else if (agent.harness === 'OpenCode') {
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}');
    if (!config || typeof config !== 'object' || Array.isArray(config) || (config.instructions !== undefined && !Array.isArray(config.instructions))) throw new Error('OPENCODE_CONFIG_CONTENT must be an object with an instructions array.');
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, instructions: [...(config.instructions || []), instructionsPath] });
  } else if (agent.harness === 'Claude Code') {
    // Merge an existing append prompt instead of supplying the same flag twice.
    const index = args.findIndex(a => a === '--append-system-prompt' || a.startsWith('--append-system-prompt='));
    if (index < 0) args.unshift('--append-system-prompt', prompt);
    else if (args[index].includes('=')) args[index] += `\n\n${prompt}`;
    else { if (typeof args[index + 1] !== 'string') throw new Error('--append-system-prompt needs a value.'); args[index + 1] += `\n\n${prompt}`; }
  } else if (agent.harness === 'Codex') {
    // Developer instructions are a per-run override. Manual mode is available
    // for profiles that manage this field themselves.
    args.unshift('-c', `developer_instructions=${JSON.stringify(prompt)}`);
  } else if (agent.harness === 'Antigravity') {
    // agy supports an interactive initial prompt and explicit workspace folders.
    // Keep the instruction file accessible without changing project rules.
    const flags = ['-i', '--prompt-interactive', '-p', '--print', '--prompt'];
    const index = args.findIndex(a => flags.includes(a) || flags.some(flag => a.startsWith(`${flag}=`)));
    if (index < 0) args.unshift('--prompt-interactive', prompt);
    else if (args[index].includes('=')) {
      const split = args[index].indexOf('=');
      args[index] = `${args[index].slice(0, split + 1)}${prompt}\n\nStartup task:\n${args[index].slice(split + 1)}`;
    } else {
      if (typeof args[index + 1] !== 'string' || args[index + 1].startsWith('-')) throw new Error(`${args[index]} needs a prompt value.`);
      args[index + 1] = `${prompt}\n\nStartup task:\n${args[index + 1]}`;
    }
    args.unshift('--add-dir', path.dirname(instructionsPath));
  }
  return { args, env, automatic: true };
}
