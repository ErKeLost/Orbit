import { useEffect, useState } from "react"
import { browserImportSources, browserImportState, importBrowserSession, type ImportReport, type ImportSource } from "../../lib/browser-import"
import { Group, Notice, PrimaryButton, Row, SecondaryButton } from "../../shared/ui/controls"
import { toast } from "../../shared/ui/toast"

/**
 * Orbit's Browser section: how the browser the agent drives gets signed in.
 *
 * The browser is a real Chrome with its own profile, so a fresh install is
 * signed out everywhere. Rather than making the user sign in again site by site,
 * this copies an existing profile's session material in. It is a copy, not a
 * link: the source browser keeps its own profile untouched, and Orbit never
 * writes into it.
 */
export function BrowserPage() {
  const [sources, setSources] = useState<ImportSource[] | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const load = async () => {
    try {
      const [found, last] = await Promise.all([browserImportSources(), browserImportState()])
      setSources(found)
      setReport(last)
      setFailure(null)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
      setSources([])
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const runImport = async (source: ImportSource) => {
    const key = `${source.browser}:${source.profile}`
    setBusy(key)
    // Two halves, and the second one is slow (one WebKit round trip per cookie),
    // so it gets a running notice instead of a promise toast that would have to
    // describe both.
    const notice = toast.info(`正在从 ${source.browser} 导入…`, { duration: Infinity })
    try {
      const { report, cookies } = await importBrowserSession(source.browser, source.profile)
      setReport(report)
      setFailure(null)
      toast.success(`已导入 ${cookies} 个 cookie`, {
        description: `${report.browser} · ${report.profile} 的登录已写入浏览器面板，可以直接用了`,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setFailure(detail)
      toast.error("导入失败", { description: detail })
    } finally {
      toast.dismiss(notice)
      setBusy(null)
    }
  }

  return (
    <>
      <Group
        title="从其他浏览器导入登录"
        description="把另一个浏览器的登录状态复制到 Orbit 的浏览器资料目录，这样 browser use 可以直接用你已有的账号。复制的是会话（cookie），不改动来源浏览器。"
      >
        {sources === null ? (
          <Notice>正在检测已安装的浏览器…</Notice>
        ) : failure ? (
          <Notice>无法读取浏览器资料：{failure}</Notice>
        ) : sources.length === 0 ? (
          <Notice>没有检测到带登录信息的 Chromium 系浏览器资料。装好 Chrome / Edge / Brave 并至少浏览过一次后再回来。</Notice>
        ) : (
          sources.map((source) => {
            const key = `${source.browser}:${source.profile}`
            const account = source.account ?? source.label
            const details = [
              source.browser,
              source.profile,
              source.cookies === null ? "cookie 数未知" : `${source.cookies} 个 cookie`,
              source.running ? "浏览器正在运行" : undefined,
            ]
              .filter(Boolean)
              .join(" · ")
            return (
              <Row key={key} label={account} description={details} anchorId={`browser-import-${key}`}>
                <PrimaryButton disabled={busy !== null} onClick={() => void runImport(source)}>
                  {busy === key ? "导入中…" : "导入"}
                </PrimaryButton>
              </Row>
            )
          })
        )}
      </Group>

      <Group title="导入状态" description="导入的是一次快照。之后在来源浏览器里新登录的站点，需要再导入一次。">
        {report ? (
          <Row
            label={`上次导入：${report.browser} · ${report.profile}`}
            description={`${report.cookies} 个 cookie · ${new Date(report.importedAt * 1000).toLocaleString()}`}
          >
            <SecondaryButton disabled={busy !== null} onClick={() => void load()}>
              刷新
            </SecondaryButton>
          </Row>
        ) : (
          <Notice>还没有导入过。browser use 目前只使用本栏里登录过的账号。</Notice>
        )}
      </Group>

      <Group title="已知限制">
        <Notice>
          导入的是 cookie，即登录状态；不包含保存的密码与自动填表。少数站点（Google 及其服务）使用「设备绑定会话」，它们要求客户端出示一把只在原浏览器资料里存在的私钥，所以这类账号导入后仍会要求你登录一次——这是 Google 的设计目的，不是导入失败。其余绝大多数站点导入即可用。
        </Notice>
      </Group>
    </>
  )
}
