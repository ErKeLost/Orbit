/**
 * How a worker names its model.
 *
 * The two halves stay apart on purpose. Pi parses a combined `provider/model`
 * reference by lowercasing the provider prefix and binding it to the first
 * case-insensitive match, so a provider whose name differs from a built-in
 * catalog entry only in case (Orbit's `Deepseek` vs the catalog's `deepseek`)
 * resolves to the catalog one — which has no credentials in auth.json, so the
 * worker starts and then dies on its first request with a misleading
 * "No API key found". Passing `--provider` and `--model` separately lets Pi pick
 * the provider that is actually authenticated.
 *
 * `AgentNode.model` still wants one readable string, which is what
 * `modelReference` is for.
 */
export type WorkerModel = { provider: string; id: string }

/** The display form, e.g. `Deepseek/deepseek-flash`. */
export function modelReference(model: WorkerModel): string {
  return `${model.provider}/${model.id}`
}

/**
 * Split a `provider/model` reference the way Pi does: the provider is the first
 * segment, everything after it is the model id — ids themselves may contain
 * slashes, e.g. llmgate's `devin/gpt-5.5`.
 *
 * Undefined for anything that is not `provider/model`, so callers can decide
 * (the spawn tool inherits the supervisor's provider for a bare id).
 */
export function parseModelReference(reference: string): WorkerModel | undefined {
  const text = reference.trim()
  const slash = text.indexOf("/")
  if (slash <= 0 || slash === text.length - 1) return undefined
  const provider = text.slice(0, slash).trim()
  const id = text.slice(slash + 1).trim()
  return provider && id ? { provider, id } : undefined
}
