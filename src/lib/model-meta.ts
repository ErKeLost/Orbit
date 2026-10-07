import type { ProviderModel } from './rpc'

export function modelLabel(id: string, fallback?: string) {
  const last = id.split('/').filter(Boolean).at(-1)
  return last || fallback || '未命名模型'
}

export function modelDisplayName(model: ProviderModel) {
  return model.name ?? modelLabel(model.id)
}

export function modelModalities(model: ProviderModel, direction: 'input' | 'output') {
  return direction === 'input' ? model.input_modalities : model.output_modalities
}

export function formatContextLength(value: unknown) {
  if (value === undefined || value === null || value === '') return '接口未返回'
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : String(value)
}
