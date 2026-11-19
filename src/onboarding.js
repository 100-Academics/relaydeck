import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const skillPath = fileURLToPath(new URL('../skills/relaydeck-chat/SKILL.md', import.meta.url));
export const automaticHarnesses = ['Hermes', 'OpenCode', 'Claude Code', 'Codex', 'Antigravity', 'pi', 'omp'];

export async function agentInstructions(agent, pinned = []) {
  const skill = await readFile(skillPath, 'utf8');
  const notes = Array.isArray(pinned) ? pinned.slice(-50) : [];
  return `${skill}\n\n${notes.length ? `## Pinned team notes (always in effect)\n\n${notes.map(p => `- ${p.body}`).join('\n')}\n\n` : ''}## This session\n\nYour Relaydeck name is ${JSON.stringify(agent.name)}; your ID is ${JSON.stringify(agent.id)}. Use the inherited bridge credentials for this identity.\n${agent.startupInstructions ? `\n## Instructions from your operator\n\n${agent.startupInstructions}\n` : ''}`;
}

// Session-only additions: never rewrite a project's AGENTS.md or global profiles.
// One deterministic mechanism: the session skill file plus the RELAYDECK_*
// environment variables. Adapters are thin wrappers that only point the
// harness at those files; every launch records the injection path used.
export function onboardingLaunch(agent, instructions, env, instructionsPath, mailPath) {
  let args = [...agent.args];
  const prompt = `You are running in Relaydeck and can use its shared chat room. Before working, read the session instructions at ${JSON.stringify(instructionsPath)} and use the Relaydeck chat skill there to discover teammates, read the room, and coordinate your assigned task.${mailPath ? ` New mail is appended to ${JSON.stringify(mailPath)} — re-read it before starting each task.` : ''} The CLI bridge is already authenticated through inherited environment variables.`;
  env = { ...env, RELAYDECK_SKILL: skillPath, RELAYDECK_INSTRUCTIONS: instructionsPath, ...(mailPath ? { RELAYDECK_MAIL: mailPath } : {}) };
  if (agent.onboarding === 'manual' || !automaticHarnesses.includes(agent.harness)) return { args, env, automatic: false, injection: 'env:RELAYDECK_INSTRUCTIONS' };
  if (agent.harness === 'Hermes') {
    env.HERMES_ENVIRONMENT_HINT = [env.HERMES_ENVIRONMENT_HINT, instructions].filter(Boolean).join('\n\n');
    return { args, env, automatic: true, injection: 'env:HERMES_ENVIRONMENT_HINT' };
  }
  if (agent.harness === 'OpenCode') {
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}');
    if (!config || typeof config !== 'object' || Array.isArray(config) || (config.instructions !== undefined && !Array.isArray(config.instructions))) throw new Error('OPENCODE_CONFIG_CONTENT must be an object with an instructions array.');
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, instructions: [...(config.instructions || []), instructionsPath] });
    return { args, env, automatic: true, injection: 'env:OPENCODE_CONFIG_CONTENT' };
  }
  if (agent.harness === 'Claude Code' || agent.harness === 'pi' || agent.harness === 'omp') {
    appendPromptFlag(args, '--append-system-prompt', prompt);
    return { args, env, automatic: true, injection: agent.harness === 'omp' ? 'flag:--append-system-prompt=' : 'flag:--append-system-prompt' };
  }
  if (agent.harness === 'Codex') {
    // Developer instructions are a per-run override. Manual mode is available
    // for profiles that manage this field themselves.
    args.unshift('-c', `developer_instructions=${JSON.stringify(prompt)}`);
    return { args, env, automatic: true, injection: 'config:developer_instructions' };
  }
  if (agent.harness === 'Antigravity') {
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
    return { args, env, automatic: true, injection: 'flag:--prompt-interactive' };
  }
}

// Merge into an existing flag instead of supplying the same flag twice;
// handles both `flag value` and `flag=value` forms.
function appendPromptFlag(args, flag, prompt) {
  const index = args.findIndex(a => a === flag || a.startsWith(`${flag}=`));
  if (index < 0) { args.unshift(flag, prompt); return; }
  if (args[index].includes('=')) args[index] += `\n\n${prompt}`;
  else {
    if (typeof args[index + 1] !== 'string') throw new Error(`${flag} needs a value.`);
    args[index + 1] += `\n\n${prompt}`;
  }
}
