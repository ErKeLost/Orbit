import { useEffect, useState } from "react"
import { browserImportSources, browserImportState, importBrowserSession, importSummary, useBrowserImportStatus, type ImportReport, type ImportSource } from "../../lib/browser-import"
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
  const { busy: importing } = useBrowserImportStatus()
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
      const { report } = await importBrowserSession(source.browser, source.profile)
      setReport(report)
      setFailure(null)
      toast.success(importSummary(report), {
        description: `${report.browser} · ${report.profile}。${report.skippedDomains?.length ? `未完整导入：${report.skippedDomains.join("、")}` : "登录是否有效由站点决定。"}`,
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
      {failure ? <Notice>{failure}</Notice> : null}
      <Group
        title="从其他浏览器导入登录"
        description="选择要复制的浏览器资料，将可导入的 Cookie 写入 Orbit 面板并验证。不改动来源浏览器；建议先退出来源浏览器，让最新登录状态落盘。"
      >
        {sources === null ? (
          <Notice>正在检测已安装的浏览器…</Notice>
        ) : sources.length === 0 ? (
          <Notice>没有检测到可导入的浏览器资料。支持 Chrome、Edge、Brave、Arc 和 Firefox 等浏览器。</Notice>
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
                <PrimaryButton disabled={importing} onClick={() => void runImport(source)}>
                  {busy === key ? "导入中…" : "导入"}
                </PrimaryButton>
              </Row>
            )
          })
        )}
      </Group>

      <SecondaryButton disabled={importing} onClick={()=>void load()}>刷新浏览器资料</SecondaryButton>
      <Group title="导入状态" description="导入的是一次快照。之后在来源浏览器里新登录的站点，需要再导入一次。">
        {report ? (
          <Row
            label={`上次导入：${report.browser} · ${report.profile}`}
            description={`${importSummary(report)} · ${new Date(report.importedAt * 1000).toLocaleString()}${report.skippedDomains?.length ? ` · 未完整导入：${report.skippedDomains.join("、")}` : ""}`}
          >
            <SecondaryButton disabled={importing} onClick={() => void load()}>
              刷新
            </SecondaryButton>
          </Row>
        ) : (
          <Notice>还没有导入过。browser use 目前只使用本栏里登录过的账号。</Notice>
        )}
      </Group>

      <Group title="已知限制">
        <Notice>
          导入 Cookie 不等于完整复制登录。密码、自动填表、Local Storage、IndexedDB、分区 Cookie 和设备绑定密钥不会迁移；依赖这些数据或站点风控的账号可能仍需登录。请在实际站点确认登录状态。
        </Notice>
      </Group>
    </>
  )
}
