import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { htmlArtifactUrl } from "../artifacts";

type FrameTheme = { scheme: "dark" | "light"; vars: Record<string, string> };

/**
 * 页面能看见的一组变量。
 *
 * 它们必须是**具体颜色**：沙箱里的页面拿不到应用的变量，`var()` 和
 * `color-mix()` 在那里没有意义。所以先用一个探针把每个值解析成 rgb 再发过去。
 */
const THEME_COLORS: Record<string, string> = {
  "--background": "var(--color-background-base)",
  "--foreground": "var(--color-content)",
  "--muted": "color-mix(in srgb, var(--color-content) 55%, var(--color-background-base))",
  "--surface": "color-mix(in srgb, var(--color-content) 5%, var(--color-background-base))",
  "--border": "color-mix(in srgb, var(--color-content) 12%, var(--color-background-base))",
  "--accent": "var(--color-accent)",
  "--link": "var(--link-color)",
  "--positive": "var(--color-diff-add)",
  "--negative": "var(--color-diff-del)",
};
const CHART_COLORS = ["var(--color-accent)", "#10b981", "#f59e0b", "#f43f5e", "#a78bfa", "#22d3ee"];

function readTheme(): FrameTheme {
  const root = document.documentElement;
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolve = (value: string) => {
    probe.style.color = value;
    return getComputedStyle(probe).color;
  };
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(THEME_COLORS)) vars[name] = resolve(value);
  CHART_COLORS.forEach((value, index) => {
    vars[`--chart-${index + 1}`] = resolve(value);
  });
  probe.remove();
  const style = getComputedStyle(root);
  vars["--font-sans"] = style.getPropertyValue("--font-sans").trim();
  vars["--font-mono"] = style.getPropertyValue("--font-mono").trim();
  vars["--radius"] = "10px";
  return { scheme: root.classList.contains("theme-light") ? "light" : "dark", vars };
}

/** 应用主题，跟着主题类名和外观变量的变化走。 */
function useFrameTheme(): FrameTheme {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

const MIN_HEIGHT = 80;
const PLACEHOLDER_HEIGHT = 240;

/**
 * 一个 `html` 产物的沙箱框。
 *
 * 它永远拿不到 `allow-same-origin`，所以页面跑在 opaque origin 里，够不到应用；
 * 服务端回来的 CSP 也让它发不出请求。框的高度跟着页面自己报的高度走，
 * 于是滚动交给外面那一层——而不是在框里再套一个滚动条。
 */
export function HtmlArtifactFrame({ id, title, version }: { id: string; title: string; version: number }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const theme = useFrameTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [ready, setReady] = useState(false);
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  const postTheme = () =>
    frameRef.current?.contentWindow?.postMessage({ type: "orbit:theme", ...themeRef.current }, "*");

  useEffect(postTheme, [theme]);
  useEffect(() => {
    setReady(false);
    setContentHeight(null);
  }, [version]);

  // 从插入那一帧就开始听：页面很快的话，第一批发来的消息会漏掉。
  useLayoutEffect(() => {
    const receive = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { type?: unknown } | null;
      if (!data || typeof data !== "object") return;
      if (data.type === "orbit:ready") {
        postTheme();
        setReady(true);
      } else if (data.type === "orbit:height") {
        const height = (data as { height?: unknown }).height;
        if (typeof height === "number" && Number.isFinite(height)) setContentHeight(Math.max(MIN_HEIGHT, Math.ceil(height)));
      } else if (data.type === "orbit:open-link") {
        const url = (data as { url?: unknown }).url;
        // 只认读者刚点的那条链接：那时焦点在框里。
        if (typeof url === "string" && /^https?:\/\//i.test(url) && document.activeElement === frame)
          void openUrl(url).catch(() => undefined);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  const height = contentHeight ?? PLACEHOLDER_HEIGHT;
  return (
    <iframe
      ref={frameRef}
      data-html-artifact={id}
      src={`${htmlArtifactUrl(id)}?v=${version}`}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={() => {
        // 盖住「加载期间主题换了」这一种。
        postTheme();
        setReady(true);
      }}
      // 拿到主题之前不显示：深色应用不该先闪一下框自带的空白白页。
      className="block w-full border-0 transition-opacity duration-150"
      style={{ height, opacity: ready ? 1 : 0, colorScheme: ready ? theme.scheme : "light" }}
    />
  );
}
