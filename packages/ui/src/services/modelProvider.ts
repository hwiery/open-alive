/**
 * Which AI company a model id belongs to, so the UI can show its logo next to
 * the model that is doing the work.
 *
 * Gateway ids come in many shapes — `claude-opus-5-5`, `gemini/gemini-3-pro`,
 * `openrouter/anthropic/claude-…`, `ollama/llama4`, `gpt-5.1-codex` — so the
 * match runs over every path segment, most specific vendor first. Unknown ids
 * map to `other`; the badge then shows a neutral mark instead of guessing.
 */
export type ModelProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'meta'
  | 'mistral'
  | 'deepseek'
  | 'xai'
  | 'qwen'
  | 'moonshot'
  | 'zhipu'
  | 'other';

const RULES: ReadonlyArray<readonly [ModelProvider, RegExp]> = [
  ['anthropic', /^(anthropic|claude)\b|^claude-|^(opus|sonnet|haiku|fable)$/],
  ['openai', /^(openai|gpt|chatgpt|codex)\b|^gpt-|^o[1-9](-|$)/],
  ['google', /^(google|gemini|gemma|vertex_ai)\b|^gemini-|^gemma/],
  ['meta', /^(meta|meta-llama|llama)\b|^llama/],
  ['mistral', /^(mistral|mistralai|mixtral|codestral|ministral|magistral|devstral)/],
  ['deepseek', /^deepseek/],
  ['xai', /^(xai|x-ai|grok)/],
  ['qwen', /^(qwen|qwq|alibaba|dashscope)/],
  ['moonshot', /^(moonshot|moonshotai|kimi)/],
  ['zhipu', /^(zhipu|zai|z-ai|glm|chatglm)/],
];

export function modelProvider(model: string | undefined | null): ModelProvider {
  if (!model) return 'other';
  const segments = model.toLowerCase().split(/[/:@]/).filter(Boolean);
  // The model name (last segment) is the most reliable; routers prefix their own name.
  for (const segment of [...segments].reverse()) {
    for (const [provider, pattern] of RULES) {
      if (pattern.test(segment)) return provider;
    }
  }
  return 'other';
}
