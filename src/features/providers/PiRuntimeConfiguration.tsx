import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Input, Toggle } from "../../shared/ui/controls";
import { connect, disconnect, getPiRuntimeSettings, probePiRuntime, report, savePiRuntimeSettings, type PiEnvironmentVariable, type PiRuntimeSettings } from "../../lib/rpc";
import { useWorkspace } from "../../lib/store";
import { toast } from "../../shared/ui/toast";

let nextVariable = 0;
type EnvironmentRow = PiEnvironmentVariable & { id: string };
function rowsFor(environment: PiEnvironmentVariable[]): EnvironmentRow[] { return environment.map(variable => ({ ...variable, id: `pi-env-${nextVariable++}` })); }

function RuntimeForm({ initial, onSaved }: { initial: PiRuntimeSettings; onSaved: () => void }) {
  const [binaryPath, setBinaryPath] = useState(initial.binaryPath);
  const [launchArgs, setLaunchArgs] = useState(initial.launchArgs);
  const [environment, setEnvironment] = useState(() => rowsFor(initial.environment));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const online = useWorkspace(state => state.connection === "online");
  const running = useWorkspace(state => state.transcript.running);
  const config = (): PiRuntimeSettings => ({
    binaryPath, launchArgs,
    environment: environment
      .filter(variable => variable.name.trim() || variable.value || variable.valueRedacted)
      .map(variable => ({ name: variable.name, value: variable.value, sensitive: variable.sensitive, valueRedacted: variable.valueRedacted })),
  });
  const names = environment.map(variable => variable.name.trim()).filter(Boolean);
  const invalid = environment.some(variable => variable.name.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name.trim())) || new Set(names).size !== names.length;
  function updateVariable(id: string, patch: Partial<PiEnvironmentVariable>) {
    setEnvironment(rows => rows.map(variable => variable.id === id ? { ...variable, ...patch, ...(patch.value !== undefined ? { valueRedacted: false } : {}) } : variable));
    setStatus("");
  }
  async function test() {
    setBusy(true); setStatus("");
    try { const result = await probePiRuntime(config()); setStatus(`Pi ${result.version} · ${result.source === "bundled" ? "内置运行时" : "自定义路径"} · ${result.pi}`); }
    catch (error) { setStatus(String(error)); }
    finally { setBusy(false); }
  }
  async function save(reconnect: boolean) {
    setBusy(true);
    try {
      const saved = await savePiRuntimeSettings(config());
      setEnvironment(rowsFor(saved.config.environment));
      if (reconnect) { const cwd = useWorkspace.getState().cwd; await disconnect(); await connect(cwd); }
      onSaved();
      toast.success(reconnect ? "Pi 配置已保存并重新连接" : "Pi 配置已保存，新启动的进程将使用新配置", { showTimestamp: false });
    } catch (error) { report(error); }
    finally { setBusy(false); }
  }
  return <>
    <div className="provider-runtime-fields">
      <label>可执行文件路径<Input aria-label="Pi 可执行文件路径" value={binaryPath} placeholder="留空使用 Orbit 内置 Pi；也可填写 pi 或绝对路径" spellCheck={false} onChange={event => { setBinaryPath(event.target.value); setStatus(""); }} /><small>支持 Pi 命令、独立可执行文件或 Node CLI 脚本。</small></label>
      <label>启动参数<Input aria-label="Pi 启动参数" value={launchArgs} placeholder="例如 --thinking high --model anthropic/claude-sonnet-4-6" spellCheck={false} onChange={event => { setLaunchArgs(event.target.value); setStatus(""); }} /><small>按字面参数传入，不执行 shell。会话与 RPC 模式由 Orbit 管理。</small></label>
    </div>
    <div className="provider-runtime-environment">
      <div className="provider-runtime-environment-head"><div><strong>环境变量</strong><p>传给本机 Pi 进程及其子进程，覆盖同名的系统变量。</p></div><Button variant="outline" disabled={busy} onClick={() => setEnvironment(rows => [...rows, { id: `pi-env-${nextVariable++}`, name: "", value: "", sensitive: true }])}>添加变量</Button></div>
      {environment.map((variable, index) => <div className="provider-environment-row" key={variable.id}>
        <Input aria-label={`环境变量名 ${index + 1}`} disabled={variable.valueRedacted} value={variable.name} placeholder="VARIABLE_NAME" spellCheck={false} onChange={event => updateVariable(variable.id, { name: event.target.value })} />
        <Input aria-label={`环境变量值 ${index + 1}`} type={variable.sensitive ? "password" : "text"} value={variable.value} placeholder={variable.valueRedacted ? "已保存，输入新值替换" : "value"} autoComplete="off" spellCheck={false} onChange={event => updateVariable(variable.id, { value: event.target.value })} />
        <label className="provider-env-sensitive"><Toggle label={`环境变量 ${index + 1} 为敏感值`} on={variable.sensitive} disabled={variable.valueRedacted} onChange={sensitive => updateVariable(variable.id, { sensitive })} />敏感</label>
        <Button variant="ghost" disabled={busy} aria-label={`删除环境变量 ${index + 1}`} onClick={() => setEnvironment(rows => rows.filter(row => row.id !== variable.id))}>删除</Button>
      </div>)}
      <p className="provider-runtime-note">敏感值单独保存，保存后不会返回界面。重新输入后可以改名或改为明文；删除变量后恢复系统环境。</p>
      {invalid && <p role="alert" className="provider-field-error">变量名需要有效且不能重复。</p>}
    </div>
    <div className="provider-runtime-footer"><p role="status">{status}</p><div className="provider-detail-actions"><Button variant="outline" disabled={busy || invalid} onClick={() => void test()}>检查运行时</Button><Button variant="outline" disabled={busy || running || invalid} onClick={() => void save(false)}>保存</Button>{online && <Button variant="default" disabled={busy || running || invalid} onClick={() => void save(true)}>保存并重连</Button>}</div></div>
  </>;
}

export function PiRuntimeConfiguration({ onSaved }: { onSaved: () => void }) {
  const settings = useQuery({ queryKey: ["pi-runtime-settings"], queryFn: getPiRuntimeSettings });
  return <section className="provider-card provider-runtime">
    <header className="provider-card-head"><div><h3>Pi 运行配置 <span className="provider-status" data-tone="muted">本机</span></h3><p>配置运行 Agent 的程序。下面的订阅和模型端点由这套 Pi 运行时使用。</p></div></header>
    {settings.data && <RuntimeForm initial={settings.data.config} onSaved={() => { void settings.refetch(); onSaved(); }} />}
    {settings.isPending && <p>正在读取本机配置…</p>}
    {settings.error && <p role="alert" className="provider-field-error">{String(settings.error)}</p>}
  </section>;
}
