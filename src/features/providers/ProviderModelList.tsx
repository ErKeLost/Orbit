import { memo, useDeferredValue, useMemo, useState } from "react";
import { Button, Disclosure, Input, Select } from "../../shared/ui/controls";
import { Icon } from "../../components/Icon";
import { ModelLogo, ModelModalities } from "../../components/ModelMeta";
import { formatContextLength, modelDisplayName, modelModalities } from "../../lib/model-meta";
import type { ModelEffort, ProviderModel } from "../../lib/rpc";
import { effortLevels } from "./effort-levels";

const display = (value: unknown) => {
  if (value === undefined || value === null || value === "") return "接口未返回";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "接口返回空数组";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
};

const formatPricing = (pricing?: Record<string, number>) => {
  if (!pricing) return undefined;
  const parts = Object.entries(pricing).filter(([, value]) => typeof value === "number");
  return parts.length ? parts.map(([key, value]) => `$${value}/M ${key}`).join(" · ") : undefined;
};

type ImageDefault = { currentId: string; onUse: (model: ProviderModel) => void };

function ModelDetails({ model, onUse, disabled, imageDefault, effort, onEffortChange, native = false }: { model: ProviderModel; onUse: () => void; disabled: boolean; native?: boolean; effort?: ModelEffort; onEffortChange: (next?: ModelEffort) => void; imageDefault?: ImageDefault }) {
  // Image-only providers have no chat model to switch to: the row's job is to
  // pick the model the generate_image tool uses.
  if (imageDefault) return (
    <div className="provider-model-details">
      <dl className="provider-meta-grid">
        <div><dt>ID</dt><dd>{display(model.id)}</dd></div>
        <div><dt>名称</dt><dd>{display(modelDisplayName(model))}</dd></div>
        <div><dt>用途</dt><dd>图片生成（generate_image）</dd></div>
      </dl>
      <Button variant="outline" className="provider-use-model" disabled={disabled || imageDefault.currentId === model.id} onClick={() => imageDefault.onUse(model)}>
        <Icon name={imageDefault.currentId === model.id ? "check" : "image-plus"} />
        {imageDefault.currentId === model.id ? "当前图片默认模型" : "设为图片默认模型"}
      </Button>
    </div>
  );
  const inputs = modelModalities(model, "input");
  const outputs = modelModalities(model, "output");
  const levels = effort?.levels ?? [];
  const levelSet = new Set(levels);
  const thinkingLevels = model.thinking_levels ?? {};
  const detected = Object.keys(thinkingLevels).filter(level => thinkingLevels[level] != null);
  return (
    <div className="provider-model-details">
      <dl className="provider-meta-grid">
        <div><dt>ID</dt><dd>{display(model.id)}</dd></div>
        <div><dt>名称</dt><dd>{display(modelDisplayName(model))}</dd></div>
        <div><dt>上下文长度</dt><dd>{display(model.context_window)}</dd></div>
        <div><dt>最大输出</dt><dd>{display(model.max_output_tokens)}</dd></div>
        <div><dt>输入类型</dt><dd>{display(inputs)}</dd></div>
        <div><dt>输出类型</dt><dd>{display(outputs)}</dd></div>
        <div><dt>端点类型</dt><dd>{display(model.raw?.supported_endpoint_types)}</dd></div>
        <div><dt>Thinking / reasoning</dt><dd>{display(model.reasoning)}</dd></div>
        <div><dt>支持参数</dt><dd>{display(model.raw?.supported_parameters)}</dd></div>
        <div><dt>价格（美元 / 百万 tokens）</dt><dd>{formatPricing(model.pricing)}</dd></div>
      </dl>
      {!native && <div className="provider-model-effort">
        <div className="provider-model-effort-head">
          <strong>支持的 Effort 档位</strong>
          <small>{detected.length ? `接口返回：${detected.join("、")}` : "接口未返回档位，可手动指定"}</small>
        </div>
        <div className="provider-effort-options" role="group" aria-label={`${model.id} 支持的 Effort 档位`}>
          {effortLevels.map(level => {
            const on = levelSet.has(level);
            return <button key={level} type="button" role="checkbox" aria-checked={on} aria-label={level} title={on ? `取消 ${level}` : `启用 ${level}`} disabled={disabled} onClick={() => {
              const next = effortLevels.filter(value => value === level ? !on : levelSet.has(value));
              const keepDefault = effort?.default && next.some(value => value === effort.default) ? effort.default : undefined;
              onEffortChange(next.length || keepDefault ? { levels: [...next], default: keepDefault } : undefined);
            }}>{level}</button>;
          })}
        </div>
        {levels.length > 0 ? (
          <label className="provider-model-effort-default"><span>切换到该模型时使用</span>
            <Select label="默认 Effort" value={effort?.default ?? ""} options={[{ value: "", label: "保持 Pi 当前档位" }, ...levels.map(value => ({ value, label: value }))]} onChange={value => onEffortChange({ levels, default: value || undefined })} />
          </label>
        ) : <small className="provider-model-effort-hint">未选择时沿用模型自身的能力。</small>}
      </div>}
      {native && <p>支持的 Effort：{detected.join("、") || "由 Pi 管理"}</p>}
      <Button variant="outline" className="provider-use-model" disabled={disabled} onClick={onUse}><Icon name="check" />使用此模型</Button>
      <Disclosure title={<span className="provider-disclosure-title"><Icon name="file-script" />接口原始元数据</span>}>
        <pre className="provider-raw-metadata">{JSON.stringify(model.raw, null, 2)}</pre>
      </Disclosure>
    </div>
  );
}

type RowProps = {
  model: ProviderModel;
  isDefault: boolean;
  native: boolean;
  disabled: boolean;
  effort?: ModelEffort;
  imageDefault?: ImageDefault;
  onUse: (model: ProviderModel) => void;
  onEffortChange: (modelId: string, next?: ModelEffort) => void;
};

/**
 * 一个大供应商就是 300+ 行。行本身是纯展示 + 一个 Disclosure 的开合状态，
 * `memo` 让搜索框每敲一个字时只有真正进出结果集的行才重新渲染。
 */
const ModelRow = memo(function ModelRow({ model, isDefault, native, disabled, effort, imageDefault, onUse, onEffortChange }: RowProps) {
  const inputs = modelModalities(model, "input");
  const outputs = modelModalities(model, "output");
  return (
    <Disclosure
      title={
        <span className="provider-model-title">
          <span className="provider-model-name"><ModelLogo modelId={model.id} size={19} /><strong>{modelDisplayName(model)}</strong>{isDefault && <span className="provider-model-default">默认</span>}{model.type === "image" && <span className="provider-model-badge">图片</span>}</span>
          {typeof model.context_window === "number" ? (<span className="provider-model-context">{formatContextLength(model.context_window)}<small> tokens</small></span>) : null}
          <ModelModalities values={inputs} />
          {inputs?.length && outputs?.length ? <span className="provider-model-arrow" aria-hidden>→</span> : null}
          <ModelModalities values={outputs} />
        </span>
      }
    >
      <ModelDetails
        model={model}
        native={native}
        disabled={disabled}
        effort={effort}
        imageDefault={imageDefault}
        onUse={() => onUse(model)}
        onEffortChange={next => onEffortChange(model.id, next)}
      />
    </Disclosure>
  );
});

const PAGE = 60;

export function ProviderModelList({ models, search, onSearchChange, native, disabled, imageProvider, currentImageModel, defaultModelId, effortFor, onUse, onEffortChange, onUseImage }: {
  models: ProviderModel[];
  search: string;
  onSearchChange: (value: string) => void;
  native: boolean;
  disabled: boolean;
  imageProvider: boolean;
  currentImageModel: string;
  defaultModelId?: string;
  effortFor: (id: string) => ModelEffort | undefined;
  onUse: (model: ProviderModel) => void;
  onEffortChange: (modelId: string, next?: ModelEffort) => void;
  onUseImage: (model: ProviderModel) => void;
}) {
  // 过滤是纯 CPU 工作：让输入框保持即时响应，把重活放到可被打断的延迟值上。
  const deferredSearch = useDeferredValue(search);
  const visibleModels = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((model) => `${model.id} ${modelDisplayName(model)}`.toLowerCase().includes(needle));
  }, [models, deferredSearch]);

  // 目录一次性挂 300 行会同时压上 300 个 Disclosure + 300 次 ModelLogo 匹配，
  // 首屏只铺一页，滚到底再续。搜索时结果集变化会重置回一页——在渲染期间直接派生，
  // 不靠 effect 回写状态（那样每敲一个字都会多一轮渲染）。
  const signature = `${deferredSearch}\u0000${models.length}`;
  const [paging, setPaging] = useState({ signature, limit: PAGE });
  const limit = paging.signature === signature ? paging.limit : PAGE;
  const shown = useMemo(() => visibleModels.slice(0, limit), [visibleModels, limit]);

  const imageDefault = useMemo(
    () => (imageProvider ? { currentId: currentImageModel, onUse: onUseImage } : undefined),
    [imageProvider, currentImageModel, onUseImage],
  );
  return (
    <>
      <label className="provider-search provider-model-search">
        <Icon name="search" />
        <Input aria-label="搜索模型名称或 ID" value={search} onChange={event => onSearchChange(event.target.value)} placeholder="搜索模型名称或 ID" />
        {search ? <button type="button" aria-label="清除搜索" onClick={() => onSearchChange("")}><Icon name="x" /></button> : null}
      </label>
      <div className="provider-model-list">
        {shown.map(model => (
          <ModelRow
            key={model.id}
            model={model}
            isDefault={defaultModelId === model.id}
            native={native}
            disabled={disabled}
            effort={effortFor(model.id)}
            imageDefault={imageDefault}
            onUse={onUse}
            onEffortChange={onEffortChange}
          />
        ))}
        {visibleModels.length > shown.length ? (
          <div className="provider-model-more">
            <Button variant="outline" onClick={() => setPaging({ signature, limit: limit + PAGE })}>显示更多模型（剩余 {visibleModels.length - shown.length}）</Button>
          </div>
        ) : null}
        {!models.length && <div className="provider-models-empty"><Icon name="cursor-magic-selection" /><strong>还没有模型目录</strong><p>刷新模型后会在这里显示可用模型。</p></div>}
        {models.length > 0 && !visibleModels.length && <div className="provider-models-empty"><p>没有匹配的模型。</p></div>}
      </div>
    </>
  );
}
