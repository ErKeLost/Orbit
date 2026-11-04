import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/Dialog";
import { Button, Input, Select } from "../../shared/ui/controls";
import { toast } from "../../shared/ui/toast";
import { answerProviderLogin, cancelProviderLogin, listProviderAuth, loginProvider, logoutProvider, providerLoginStatus, report, type ProviderAuth, type ProviderLogin, type ProviderLoginPrompt } from "../../lib/rpc";

function LoginPrompt({ session, prompt, onAnswer }: { session: ProviderLogin; prompt: { id: string; prompt: ProviderLoginPrompt }; onAnswer: () => void }) {
  const [value, setValue] = useState(prompt.prompt.type === "select" ? prompt.prompt.options?.[0]?.id ?? "" : "");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try { await answerProviderLogin(session.id, prompt.id, value); setValue(""); onAnswer(); }
    catch (error) { report(error); }
    finally { setBusy(false); }
  }
  return <form className="provider-login-prompt" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <label htmlFor="provider-login-answer">{prompt.prompt.message}</label>
    {prompt.prompt.type === "select"
      ? <Select label={prompt.prompt.message} value={value} onChange={setValue} options={(prompt.prompt.options ?? []).map(option => ({ value: option.id, label: option.label }))} />
      : <Input id="provider-login-answer" autoFocus autoComplete="off" type={prompt.prompt.type === "secret" ? "password" : "text"} placeholder={prompt.prompt.placeholder} value={value} onChange={event => setValue(event.target.value)} />}
    <Button type="submit" variant="default" disabled={busy}>{busy ? "提交中…" : "继续"}</Button>
  </form>;
}

function LoginDialog({ initial, name, onClose, onComplete }: { initial: ProviderLogin; name: string; onClose: () => void; onComplete: () => void }) {
  const result = useQuery({ queryKey: ["provider-login", initial.id], queryFn: () => providerLoginStatus(initial.id), initialData: initial, refetchInterval: query => query.state.data?.status === "running" ? 500 : false, retry: false });
  const session = result.data;
  const completed = useRef(false);
  const lifetime = useRef({ generation: 0 });
  // Navigation and unmount must release callback ports and pending prompts.
  // Deferring cleanup by one microtask also tolerates StrictMode's effect replay.
  useEffect(() => {
    const token = lifetime.current;
    const current = ++token.generation;
    return () => { queueMicrotask(() => { if (token.generation === current) void cancelProviderLogin(initial.id).catch(() => undefined); }); };
  }, [initial.id]);
  useEffect(() => {
    if (session.status === "done" && !completed.current) {
      completed.current = true;
      onComplete();
    }
  }, [session.status, onComplete]);
  const authUrl = session.auth_url?.url ?? session.device_code?.verificationUri;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="provider-login-dialog">
      <DialogHeader><DialogTitle>{`登录 ${name}`}</DialogTitle><DialogDescription>完成账户授权后，Orbit 会自动确认登录状态。</DialogDescription></DialogHeader>
      <div aria-live="polite" className="provider-login-content">
        {session.status === "done" ? <p>账户已连接。可在下方模型目录中应用配置。</p> : <>
          {session.auth_url?.instructions && <p>{session.auth_url.instructions}</p>}
          {authUrl && <><Button variant="outline" onClick={() => void openUrl(authUrl).catch(report)}>打开授权页面</Button><a className="provider-auth-url" href={authUrl} target="_blank" rel="noreferrer">{authUrl}</a></>}
          {session.device_code && <p>设备验证码：<code className="provider-device-code">{session.device_code.userCode}</code></p>}
          {session.info?.message && <p>{session.info.message}</p>}
          {session.info?.links?.map(link => <a key={link.url} href={link.url} target="_blank" rel="noreferrer">{link.label || link.url}</a>)}
          {session.progress?.message && <p>{session.progress.message}</p>}
          {session.status === "running" && session.prompt && <LoginPrompt key={session.prompt.id} session={session} prompt={session.prompt} onAnswer={() => void result.refetch()} />}
        </>}
        {(session.error || result.error) && <p role="alert" className="provider-field-error">{session.error || String(result.error)}</p>}
      </div>
      <DialogFooter><Button variant="outline" onClick={onClose}>{session.status === "running" ? "取消登录" : "关闭"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function SubscriptionAccounts({ onChanged, disabled }: { onChanged: () => void; disabled: boolean }) {
  const accounts = useQuery({ queryKey: ["provider-auth"], queryFn: listProviderAuth, staleTime: 10_000 });
  const [session, setSession] = useState<{ initial: ProviderLogin; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [logout, setLogout] = useState<ProviderAuth | null>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function start(account: ProviderAuth) {
    setBusy(account.id);
    try {
      const initial = await loginProvider(account.id);
      if (mounted.current) setSession({ initial, name: account.name });
      else await cancelProviderLogin(initial.id);
    }
    catch (error) { report(error); }
    finally { setBusy(null); }
  }
  const refresh = () => { void accounts.refetch(); onChanged(); };
  async function signOut() {
    if (!logout) return;
    setBusy(logout.id);
    try { await logoutProvider(logout.id); setLogout(null); refresh(); toast.success("已退出订阅账户", { showTimestamp: false }); }
    catch (error) { report(error); }
    finally { setBusy(null); }
  }
  return <section className="provider-card provider-accounts">
    <header className="provider-card-head"><div><h3>订阅与账户</h3><p>使用已有账户登录；可用方式由内置 Pi 提供。</p></div><Button variant="outline" disabled={accounts.isFetching} onClick={refresh}>刷新账户</Button></header>
    <div className="provider-account-grid">
      {accounts.data?.map(account => <div key={account.id} className="provider-account">
        <div><strong>{account.name}</strong><small>{account.oauth ? "已登录 · 自动续期" : account.configured ? "已配置 API Key" : "未登录"}</small></div>
        <div className="provider-detail-actions"><Button variant="outline" disabled={disabled || !!busy || !!session} onClick={() => void start(account)}>{busy === account.id ? "处理中…" : account.oauth ? "重新登录" : account.configured ? "改用账户登录" : "登录"}</Button>{account.oauth && <Button variant="ghost" disabled={disabled || !!busy || !!session} onClick={() => setLogout(account)}>退出</Button>}</div>
      </div>)}
      {accounts.isPending && <p>正在读取 Pi 支持的登录方式…</p>}
      {accounts.error && <p role="alert" className="provider-field-error">{String(accounts.error)}</p>}
    </div>
    {session && <LoginDialog key={session.initial.id} initial={session.initial} name={session.name} onClose={() => setSession(null)} onComplete={() => { refresh(); toast.success("订阅账户已连接", { showTimestamp: false }); }} />}
    <Dialog open={!!logout} onOpenChange={open => { if (!open) setLogout(null); }}><DialogContent>
      <DialogHeader><DialogTitle>退出订阅账户</DialogTitle><DialogDescription>移除本机保存的登录凭据。使用该账户的会话下一次请求需要重新登录。</DialogDescription></DialogHeader>
      <p>{logout?.name}</p><DialogFooter><Button variant="outline" disabled={!!busy} onClick={() => setLogout(null)}>取消</Button><Button variant="destructive" disabled={!!busy} onClick={() => void signOut()}>退出账户</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}
