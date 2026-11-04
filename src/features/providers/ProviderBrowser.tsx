import type { ProviderProfile } from "../../lib/rpc";
import { Button, Input } from "../../shared/ui/controls";
import { Icon } from "../../components/Icon";
import { ProviderMark } from "../../components/ProviderLogo";
import type { Preset } from "./presets";

/** One search field for both panes: same control, same clear affordance. */
export function ProviderSearch({ value, onChange, placeholder, className = "", ariaLabel }: { value: string; onChange: (value: string) => void; placeholder: string; className?: string; ariaLabel: string }) {
  return (
    <label className={`provider-search ${className}`.trim()}>
      <Icon name="search" />
      <Input aria-label={ariaLabel} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} />
      {value ? <button type="button" aria-label="清除搜索" onClick={() => onChange("")}><Icon name="x" /></button> : null}
    </label>
  );
}

/** 左栏：已添加的 Provider + 未添加的官方模板，两侧共用同一个搜索框。 */
export function ProviderBrowser({ search, onSearchChange, savedProviders, visibleProviders, availablePresets, templateCount, editingId, switchingId, onSelect, onOpenPreset, onNew }: {
  search: string;
  onSearchChange: (value: string) => void;
  savedProviders: ProviderProfile[];
  visibleProviders: ProviderProfile[];
  availablePresets: readonly Preset[];
  templateCount: number;
  editingId: string | null;
  switchingId: string | null;
  onSelect: (id: string) => void;
  onOpenPreset: (preset: Preset) => void;
  onNew: () => void;
}) {
  return (
    <aside className="provider-browser" aria-label="已添加的 Provider">
      <ProviderSearch ariaLabel="搜索供应商" placeholder="搜索供应商" value={search} onChange={onSearchChange} />
      <div className="provider-browser-list">
        <div className="provider-browser-group"><span>已添加</span><span>{savedProviders.length}</span></div>
        <nav aria-label="已添加的 Provider">
          {visibleProviders.map(item => <button key={item.id} type="button" className="provider-browser-item" aria-current={editingId === item.id ? "true" : undefined} aria-busy={switchingId === item.id || undefined} onClick={() => onSelect(item.id)}><ProviderMark id={item.id} name={item.name} /><span className="provider-browser-name">{item.name || item.id}</span><span className="provider-browser-count">{switchingId === item.id ? "…" : item.models?.length ?? 0}</span></button>)}
          {!savedProviders.length && <p className="provider-browser-empty">还没有添加 Provider。</p>}
        </nav>
        {templateCount > 0 && <><div className="provider-browser-group"><span>模板</span><span>{templateCount}</span></div><nav aria-label="默认 Provider">{availablePresets.map(preset => <button key={preset.id} type="button" className="provider-browser-item provider-browser-preset" onClick={() => onOpenPreset(preset)}><ProviderMark id={preset.id} /><span className="provider-browser-name">{preset.name}</span><span className="provider-browser-add-mark"><Icon name="plus" /></span></button>)}</nav></>}
        {savedProviders.length > 0 && !visibleProviders.length && !availablePresets.length && <p className="provider-browser-empty">没有匹配的 Provider。</p>}
      </div>
      <Button variant="ghost" className="provider-browser-add" onClick={onNew}><Icon name="plus" />新增 Provider</Button>
    </aside>
  );
}
