/**
 * 哪些 `href` 绝对不能交给 webview 自己导航。
 *
 * 原生 `<a href>` 的默认行为是**把当前文档换掉**。在 Orbit 里那等于把整个界面
 * 替换成目标文档，而且换不回来（没有地址栏，也没有后退键）。如果目标的 MIME 是
 * XML 类型（`image/svg+xml`、`application/xml`、`text/xml`）而内容不是合法 XML，
 * 用户看到的就是浏览器自带的解析错误页：
 *
 *     This page contains the following errors:
 *     error on line 1 at column 2: StartTag: invalid element name
 *
 * 所以除了 `http(s)`（交给系统浏览器）和 `mailto:`（交给系统邮件）以外，
 * 一律不许导航。带 scheme 的（`data:` / `blob:` / `file:` / `asset:` /
 * `orbitartifact:` …）显式拦掉；不带 scheme 的相对地址交给上层按普通链接处理。
 */

/** 允许按「打开外部程序」处理的协议。 */
export function opensExternally(href: string): boolean {
  return /^(?:https?:|mailto:)/i.test(href.trim());
}

/**
 * 会让 webview 换文档的协议：`data:` 和 `blob:` 可以携带任意 MIME（包括 XML），
 * `file:` / `asset:` / `orbitartifact:` 是本机内容，其余是未知协议。
 */
export function navigatesWebview(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  if (opensExternally(trimmed)) return false;
  // `//host/path` 是协议相对地址，真点了也是离开应用。
  if (trimmed.startsWith("//")) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}
