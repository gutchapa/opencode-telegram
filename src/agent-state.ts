// Shared in-memory state for slash commands.
// Settings here are per-process (lost on bot restart) and act as session defaults
// for the agentic path.

export interface AgentState {
  activation: 'always' | 'mention';
  fast: boolean;
  verbose: boolean;
  trace: boolean;
  thinking: number; // 0 (off) | 1 (brief) | 2 (full)
  reasoning: boolean;
  usage: 'off' | 'tokens' | 'full';
  elevated: boolean;
  focus: boolean;
  prose: boolean;
  goal: string;
  steer: string;
  model: string; // override for the direct-Qwen fallback; empty = use env
  name: string;
}

const state: AgentState = {
  activation: 'always',
  fast: false,
  verbose: false,
  trace: false,
  thinking: 0,
  reasoning: true,
  usage: 'off',
  elevated: false,
  focus: false,
  prose: false,
  goal: '',
  steer: '',
  model: '',
  name: 'opencode-bot',
};

export function getAgentState(): AgentState {
  return state;
}

export function setAgentState(patch: Partial<AgentState>): AgentState {
  Object.assign(state, patch);
  return state;
}
