/**
 * The local model a terminal tab can run Codex on (`codex --oss`), read from
 * `OA_LOCAL_MODEL` / `OA_LOCAL_PROVIDER` in `~/.open-alive/.env` or the
 * process env. Unset → no local preset is offered.
 */

export type LocalProvider = 'ollama' | 'lmstudio';

export interface LocalModel {
  model: string;
  provider: LocalProvider;
}

const PROVIDERS: readonly LocalProvider[] = ['ollama', 'lmstudio'];
// Ollama tags (`gemma4:12b-it-qat`) and LM Studio ids (`qwen/qwen3-8b`). The
// name ends up in a shell command, so anything else is refused.
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function resolveLocalModel(env: NodeJS.ProcessEnv): LocalModel | null {
  const model = env.OA_LOCAL_MODEL?.trim();
  if (!model || !MODEL_NAME.test(model)) return null;
  const provider = (env.OA_LOCAL_PROVIDER?.trim() || 'ollama') as LocalProvider;
  if (!PROVIDERS.includes(provider)) return null;
  return { model, provider };
}
