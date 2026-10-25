import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QuickComposer } from "./QuickComposer";
import "../index.css";

/**
 * Quick composer 的入口。
 *
 * 这是一个**独立的 webview**：没有 store、没有连接、没有路由。它只认两件事——
 * 用户打了什么字，以及主窗口现在在哪个目录里。发出去之后由主窗口负责剩下的。
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QuickComposer />
  </StrictMode>,
);
