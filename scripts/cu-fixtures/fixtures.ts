// Simulated desktop applications for Jev-in-the-loop benchmarks.
//
// Only the OS layer is simulated: each fixture renders an accessibility tree
// in the same normalized shape the xa11y worker returns, and applies actions
// addressed by snapshot refs. The real candidate compiler, engine, verifier
// and live Jev run unchanged. Success is judged from the fixture's own state
// (an independent postcondition), never from Jev's DONE.
import type { DesktopDriver, DesktopEnvelope, DesktopNode, SnapshotData } from "../../src-tauri/resources/computer-use/desktop-driver.ts"
import type { GuiTaskInput } from "../../src-tauri/resources/computer-use/gui-task-contract.ts"

export type FNode = {
  role: string
  name?: string
  description?: string
  value?: string
  id?: string
  actions?: string[]
  states?: string[]
  bounds?: { x: number; y: number; width: number; height: number }
  children?: FNode[]
  press?: () => void
  setValue?: (value: string) => void
  scroll?: (direction: "up" | "down") => void
  scrollTo?: () => void
}

export type Fixture = {
  name: string
  task: Omit<GuiTaskInput, "budget"> & { budget?: GuiTaskInput["budget"] }
  render(): FNode
  key?(key: "return" | "escape"): void
  nowPlaying?(): { title: string; artist?: string; playing: boolean } | undefined
  /** Application menu bar: items with exact paths. */
  menu?(): { path: string[]; enabled?: boolean; shortcut?: string; checked?: boolean; press: () => void }[]
  success(): boolean
  /** Actions that must never happen (e.g. messaging the wrong person). */
  violation?(): string | undefined
}

const b = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

export function button(id: string, name: string, bounds: FNode["bounds"], press: () => void, extra: Partial<FNode> = {}): FNode {
  return { role: "button", id, name, actions: ["Click"], bounds, press, ...extra }
}
export function text(value: string, bounds?: FNode["bounds"]): FNode {
  return { role: "static_text", name: value, bounds }
}
export function field(id: string, name: string, value: string, bounds: FNode["bounds"], setValue: (value: string) => void, role = "text_field"): FNode {
  return { role, id, name, value, actions: ["SetValue", "SetFocus"], states: ["editable"], bounds, setValue }
}
export function window(title: string, children: FNode[]): FNode {
  return { role: "window", id: "win", name: title, actions: ["Activate"], bounds: b(0, 0, 1000, 700), children }
}

// ---------------------------------------------------------------- calculator
export function calculator(): Fixture {
  let display = "0"
  let acc: number | undefined
  let op: string | undefined
  let fresh = true
  let lastEquals = false
  const digit = (d: string) => () => { display = fresh || display === "0" ? d : display + d; fresh = false; lastEquals = false }
  const apply = () => {
    const current = Number(display)
    if (acc === undefined || !op) return current
    return op === "+" ? acc + current : op === "-" ? acc - current : op === "×" ? acc * current : acc / current
  }
  const operator = (o: string) => () => { acc = apply(); op = o; display = String(acc); fresh = true; lastEquals = false }
  const keys = [["AC", "±", "%", "÷"], ["7", "8", "9", "×"], ["4", "5", "6", "-"], ["1", "2", "3", "+"], ["0", ".", "="]]
  const labels: Record<string, string> = { "÷": "除", "×": "乘", "-": "减", "+": "加", "=": "等于", AC: "全部清除", "±": "正负号", "%": "百分比", ".": "小数点" }
  return {
    name: "calculator",
    task: { goal: "在计算器中计算 12+30，并让结果显示为 42", target: { app: "Calculator" } },
    render: () => window("计算器", [
      { role: "group", id: "display", bounds: b(0, 0, 240, 80), children: [text(display, b(10, 20, 220, 50))] },
      { role: "group", id: "keypad", bounds: b(0, 80, 240, 300), children: keys.flatMap((row, r) => row.map((k, c) => button(`k${k}`, labels[k] ?? k, b(c * 60, 80 + r * 60, k === "0" ? 120 : 60, 60),
        /\d/.test(k) ? digit(k) : ["+", "-", "×", "÷"].includes(k) ? operator(k) : k === "=" ? () => { display = String(apply()); acc = undefined; op = undefined; fresh = true; lastEquals = true } : k === "AC" ? () => { display = "0"; acc = undefined; op = undefined; fresh = true } : () => undefined))) },
    ]),
    success: () => display === "42" && lastEquals,
  }
}

// --------------------------------------------------------------------- music
export function music(): Fixture {
  let query = ""
  let submitted = ""
  let playing: { title: string; artist: string } | undefined
  const catalog = [
    { title: "晴天", artist: "周杰伦" },
    { title: "晴天 (Live)", artist: "周杰伦" },
    { title: "晴天娃娃", artist: "群星" },
    { title: "雨天", artist: "孙燕姿" },
  ]
  const results = () => submitted ? catalog.filter(song => song.title.includes(submitted)) : []
  return {
    name: "music",
    task: {
      goal: "在音乐应用里搜索准备好的歌曲，并播放周杰伦原版（不是 Live 版）",
      target: { app: "Music" },
      textSlots: [{ id: "song", value: "晴天", description: "要搜索的歌名" }],
    },
    render: () => window("音乐", [
      { role: "group", id: "sidebar", bounds: b(0, 0, 200, 700), children: [
        button("nav-home", "首页", b(10, 60, 180, 32), () => undefined),
        button("nav-library", "资料库", b(10, 100, 180, 32), () => undefined),
        button("nav-radio", "电台", b(10, 140, 180, 32), () => undefined),
      ] },
      { role: "group", id: "main", bounds: b(200, 0, 800, 620), children: [
        field("search", "搜索", query, b(220, 10, 400, 30), value => { query = value }, "search_field"),
        button("search-go", "搜索", b(630, 10, 60, 30), () => { submitted = query }),
        { role: "list", id: "results", actions: ["Scroll"], bounds: b(200, 60, 800, 500), children: results().map((song, i) => ({
          role: "group", id: `row${i}`, bounds: b(210, 70 + i * 56, 780, 50), children: [
            text(song.title, b(220, 75 + i * 56, 300, 20)),
            text(song.artist, b(220, 95 + i * 56, 300, 20)),
            button(`play${i}`, "播放", b(940, 80 + i * 56, 40, 30), () => { playing = song }),
          ],
        })) },
      ] },
      { role: "group", id: "player", bounds: b(0, 620, 1000, 80), children: [
        text(playing ? `${playing.title} - ${playing.artist}` : "未在播放", b(20, 640, 300, 20)),
      ] },
    ]),
    key: key => { if (key === "return") submitted = query },
    nowPlaying: () => playing ? { ...playing, playing: true } : undefined,
    success: () => playing?.title === "晴天" && playing.artist === "周杰伦",
  }
}

// ---------------------------------------------------------------------- chat
export function chat(recipient = "李四"): Fixture {
  const contacts = ["张三", "李四", "产品工作群", "王五"]
  let active = "张三"
  const drafts: Record<string, string> = {}
  const sent: Record<string, string[]> = { 张三: ["明天见"], 李四: [], 产品工作群: ["周会改到三点"], 王五: [] }
  const message = "周五下午三点开会"
  const send = () => { const d = drafts[active]?.trim(); if (d) { sent[active].push(d); drafts[active] = "" } }
  return {
    name: "chat",
    task: {
      goal: `在聊天应用里给${recipient}发送准备好的消息`,
      target: { app: "Chat" },
      textSlots: [{ id: "msg", value: message, description: "要发送的消息" }],
    },
    render: () => window("聊天", [
      { role: "list", id: "contacts", actions: ["Scroll"], bounds: b(0, 0, 250, 700), children: contacts.map((name, i) => ({
        role: "table_cell", id: `c${i}`, name, actions: ["Click"], states: name === active ? ["selected"] : [], bounds: b(0, 10 + i * 64, 250, 60), press: () => { active = name },
      })) },
      { role: "group", id: "conversation", bounds: b(250, 0, 750, 700), children: [
        text(active, b(270, 10, 300, 24)),
        { role: "list", id: "messages", actions: ["Scroll"], bounds: b(250, 40, 750, 540), children: sent[active].map((m, i) => text(m, b(270, 50 + i * 30, 500, 24))) },
        field("composer", "输入消息", drafts[active] ?? "", b(260, 600, 620, 80), value => { drafts[active] = value }, "text_area"),
        button("send", "发送", b(900, 630, 80, 36), send),
      ] },
    ]),
    key: key => { if (key === "return") send() },
    success: () => sent[recipient].includes(message),
    violation: () => Object.entries(sent).some(([name, list]) => name !== recipient && list.includes(message)) ? "message sent to the wrong conversation" : undefined,
  }
}

// ------------------------------------------------------------------ settings
export function settings(): Fixture {
  let pane = "通用"
  const toggles: Record<string, Record<string, boolean>> = {
    通用: { 自动更新: true, 开机启动: false },
    通知: { 勿扰模式: false, 显示预览: true, 通知声音: true },
    显示: { 深色模式: false, 夜览: false },
    隐私: { 定位服务: true },
  }
  return {
    name: "settings",
    task: { goal: "在设置中打开勿扰模式", target: { app: "Settings" } },
    render: () => window("设置", [
      { role: "list", id: "sidebar", bounds: b(0, 0, 220, 700), children: Object.keys(toggles).map((name, i) => ({
        role: "table_cell", id: `p${i}`, name, actions: ["Click"], states: name === pane ? ["selected"] : [], bounds: b(0, 10 + i * 40, 220, 36), press: () => { pane = name },
      })) },
      { role: "group", id: "pane", name: pane, bounds: b(220, 0, 780, 700), children: Object.entries(toggles[pane]).map(([label, on], i) => ({
        role: "check_box", id: `t-${label}`, name: label, actions: ["Toggle"], states: on ? ["checked"] : [], bounds: b(240, 20 + i * 44, 300, 32),
        press: () => { toggles[pane][label] = !toggles[pane][label] },
      })) },
    ]),
    success: () => toggles.通知.勿扰模式 && toggles.显示.深色模式 === false && toggles.通知.显示预览,
  }
}

// ---------------------------------------------------------------- files+menu
export function files(): Fixture {
  const names = ["notes.txt", "report.pdf", "budget.xlsx", "photo.png"]
  let menuFor: string | undefined
  let shared: string | undefined
  let deleted: string | undefined
  return {
    name: "files",
    task: { goal: "在文件应用中把 report.pdf 分享出去", target: { app: "Files" } },
    render: () => window("文件", [
      ...(shared ? [text(`已通过隔空投送分享 ${shared}`, b(20, 10, 400, 24))] : []),
      { role: "list", id: "files", actions: ["Scroll"], bounds: b(0, 40, 1000, 600), children: names.filter(n => n !== deleted).map((name, i) => ({
        role: "group", id: `f${i}`, bounds: b(10, 50 + i * 50, 980, 44), children: [
          text(name, b(20, 60 + i * 50, 300, 20)),
          button(`more${i}`, "更多", b(940, 56 + i * 50, 32, 32), () => { menuFor = name }),
        ],
      })) },
      ...(menuFor ? [{ role: "menu", id: "menu", bounds: b(800, 100, 160, 120), children: [
        { role: "menu_item", id: "m-rename", name: "重命名", actions: ["Click"], bounds: b(800, 100, 160, 30), press: () => { menuFor = undefined } },
        { role: "menu_item", id: "m-share", name: "分享", actions: ["Click"], bounds: b(800, 130, 160, 30), press: () => { shared = menuFor; menuFor = undefined } },
        { role: "menu_item", id: "m-delete", name: "删除", actions: ["Click"], bounds: b(800, 160, 160, 30), press: () => { deleted = menuFor; menuFor = undefined } },
      ] } as FNode] : []),
    ]),
    key: key => { if (key === "escape") menuFor = undefined },
    success: () => shared === "report.pdf",
    violation: () => deleted ? `deleted ${deleted}` : shared && shared !== "report.pdf" ? `shared ${shared}` : undefined,
  }
}

// ------------------------------------------------------------------ readonly
export function appearance(): Fixture {
  return {
    name: "appearance-readonly",
    task: { goal: "查看设置里当前的外观模式是浅色还是深色", target: { app: "Settings" }, readOnly: true },
    render: () => window("外观", [
      { role: "group", id: "pane", name: "外观", bounds: b(0, 0, 1000, 700), children: [
        text("外观", b(20, 20, 200, 24)),
        { role: "radio_button", id: "light", name: "浅色", actions: ["Click"], states: [], bounds: b(20, 60, 100, 80), press: () => undefined },
        { role: "radio_button", id: "dark", name: "深色", actions: ["Click"], states: ["selected", "checked"], bounds: b(140, 60, 100, 80), press: () => undefined },
        { role: "radio_button", id: "auto", name: "自动", actions: ["Click"], states: [], bounds: b(260, 60, 100, 80), press: () => undefined },
      ] },
    ]),
    success: () => true,
  }
}


// ---------------------------------------------------------------------- mail
export function mail(): Fixture {
  const draft = { to: "", subject: "", body: "" }
  let sent: typeof draft | undefined
  return {
    name: "mail",
    task: {
      goal: "写一封新邮件发给准备好的收件人，主题和正文都用准备好的内容，然后发送",
      target: { app: "Mail" },
      textSlots: [
        { id: "to", value: "lisi@example.com", description: "收件人邮箱" },
        { id: "subject", value: "周报", description: "邮件主题" },
        { id: "body", value: "本周完成了登录模块。\n下周做支付。", description: "邮件正文" },
      ],
    },
    render: () => window("新邮件", [
      { role: "toolbar", id: "tb", bounds: b(0, 0, 1000, 40), children: [
        button("send", "发送", b(10, 5, 60, 30), () => { if (draft.to) { sent = { ...draft } } }, { states: draft.to ? [] : ["disabled"] }),
        button("discard", "丢弃", b(80, 5, 60, 30), () => { draft.to = draft.subject = draft.body = "" }),
      ] },
      { role: "group", id: "form", bounds: b(0, 40, 1000, 660), children: [
        text("收件人:", b(10, 50, 60, 20)), field("to", "收件人", draft.to, b(80, 50, 800, 24), v => { draft.to = v }),
        text("主题:", b(10, 80, 60, 20)), field("subject", "主题", draft.subject, b(80, 80, 800, 24), v => { draft.subject = v }),
        field("body", "正文", draft.body, b(10, 120, 980, 560), v => { draft.body = v }, "text_area"),
      ] },
      ...(sent ? [text("邮件已发送", b(400, 10, 200, 20))] : []),
    ]),
    success: () => sent?.to === "lisi@example.com" && sent.subject === "周报" && sent.body === "本周完成了登录模块。\n下周做支付。",
    violation: () => sent && sent.to !== "lisi@example.com" ? "sent to wrong recipient" : undefined,
  }
}

// ---------------------------------------------------------------- async load
export function asyncSearch(): Fixture {
  let query = ""
  let loadingTicks = -1
  let opened: string | undefined
  const items = ["Rust 程序设计", "Rust 实战", "Go 语言圣经"]
  return {
    name: "async-search",
    task: { goal: "在书店应用里搜索准备好的关键词，打开《Rust 实战》的详情页", target: { app: "Books" }, textSlots: [{ id: "q", value: "Rust", description: "搜索关键词" }] },
    render: () => {
      // results arrive after a couple of observations, like a network call
      if (loadingTicks > 0) loadingTicks--
      const ready = loadingTicks === 0
      return window("书店", opened ? [text(`详情：${opened}`, b(20, 20, 400, 30)), button("back", "返回", b(20, 60, 60, 30), () => { opened = undefined })] : [
        field("q", "搜索图书", query, b(20, 10, 500, 30), v => { query = v }, "search_field"),
        button("go", "搜索", b(530, 10, 60, 30), () => { loadingTicks = 2 }),
        ...(loadingTicks > 0 ? [{ role: "progress_bar", id: "spin", name: "正在加载", bounds: b(20, 60, 200, 20) } as FNode, text("加载中…", b(20, 90, 200, 20))] : []),
        ...(ready ? [{ role: "list", id: "res", bounds: b(20, 60, 900, 400), children: items.filter(i => i.includes(query)).map((name, i) => ({
          role: "table_cell", id: `r${i}`, name, actions: ["Click"], bounds: b(20, 60 + i * 40, 900, 36), press: () => { opened = name },
        })) } as FNode] : []),
      ])
    },
    key: key => { if (key === "return") loadingTicks = 2 },
    success: () => opened === "Rust 实战",
  }
}

// ----------------------------------------------------------------- long list
export function longList(wanted = "赵六"): Fixture {
  const names = Array.from({ length: 40 }, (_, i) => `联系人 ${String(i + 1).padStart(2, "0")}`)
  names[33] = "赵六"
  let offset = 0
  let opened: string | undefined
  const rowH = 40
  const viewport = { y: 50, h: 400 }
  return {
    name: "long-list",
    task: { goal: `在通讯录中打开${wanted}的名片`, target: { app: "Contacts" } },
    render: () => window("通讯录", [
      text(opened ? `名片：${opened}` : "所有联系人", b(20, 10, 300, 24)),
      { role: "list", id: "list", actions: ["Scroll"], bounds: b(0, viewport.y, 400, viewport.h),
        scroll: dir => { offset = Math.max(0, Math.min(names.length * rowH - viewport.h, offset + (dir === "down" ? 300 : -300))) },
        children: names.map((name, i) => ({
          role: "table_cell", id: `p${i}`, name, actions: ["Click"],
          bounds: b(0, viewport.y + i * rowH - offset, 400, rowH - 4),
          press: () => { opened = name },
          scrollTo: () => { offset = Math.max(0, i * rowH - 100) },
        } as FNode)) },
    ]),
    success: () => opened === wanted,
    violation: () => opened && opened !== wanted ? `opened ${opened}` : undefined,
  }
}

// -------------------------------------------------------------- confirmation
export function confirmDelete(): Fixture {
  const notes = ["购物清单", "会议记录", "旧草稿"]
  let asking: string | undefined
  let selected = "购物清单"
  const deleted: string[] = []
  return {
    name: "confirm-delete",
    task: { goal: "在备忘录里删除“旧草稿”这条笔记", target: { app: "Notes" } },
    render: () => window("备忘录", [
      { role: "list", id: "notes", bounds: b(0, 40, 300, 600), children: notes.filter(n => !deleted.includes(n)).map((name, i) => ({
        role: "table_cell", id: `n${i}`, name, actions: ["Click"], states: name === selected ? ["selected"] : [], bounds: b(0, 40 + i * 50, 300, 46), press: () => { selected = name },
      })) },
      ...(deleted.length ? [text(`已删除“${deleted.at(-1)}”`, b(320, 100, 300, 24))] : []),
      { role: "toolbar", id: "tb", bounds: b(300, 0, 700, 40), children: [
        button("new", "新建笔记", b(310, 5, 80, 30), () => undefined),
        button("del", "删除", b(400, 5, 60, 30), () => { asking = selected }),
      ] },
      text(`正在查看：${selected}`, b(320, 60, 300, 24)),
      ...(asking ? [{ role: "sheet", id: "sheet", bounds: b(350, 200, 300, 150), children: [
        text(`确定要删除“${asking}”吗？此操作无法撤销。`, b(360, 210, 280, 40)),
        button("cancel", "取消", b(380, 300, 80, 30), () => { asking = undefined }),
        button("confirm", "删除", b(520, 300, 80, 30), () => { if (asking) deleted.push(asking); asking = undefined; selected = notes.find(n => !deleted.includes(n)) ?? "" }),
      ] } as FNode] : []),
    ]),
    key: key => { if (key === "escape") asking = undefined },
    success: () => deleted.length === 1 && deleted[0] === "旧草稿",
    violation: () => deleted.some(n => n !== "旧草稿") ? `deleted ${deleted.join(",")}` : undefined,
  }
}

// -------------------------------------------------------------- autocomplete
export function autocomplete(): Fixture {
  let from = ""
  let chosen: string | undefined
  let searched = false
  const cities = ["上海", "上海浦东", "上饶", "北京"]
  return {
    name: "autocomplete",
    task: { goal: "在出行应用里把出发地设为准备好的城市（从建议列表选择上海本身，不是浦东），然后查询", target: { app: "Trip" }, textSlots: [{ id: "city", value: "上海", description: "出发城市" }] },
    render: () => window("出行", [
      { role: "combo_box", id: "from", name: "出发地", value: chosen ?? from, actions: ["SetValue", "SetFocus"], states: ["editable"], bounds: b(20, 20, 300, 30), setValue: v => { from = v; chosen = undefined } } as FNode,
      ...(from && !chosen ? [{ role: "list", id: "sugg", bounds: b(20, 52, 300, 160), children: cities.filter(c => c.includes(from)).map((c, i) => ({
        role: "menu_item", id: `s${i}`, name: c, actions: ["Click"], bounds: b(20, 52 + i * 32, 300, 30), press: () => { chosen = c },
      })) } as FNode] : []),
      button("search", "查询", b(340, 20, 80, 30), () => { searched = true }),
      ...(searched ? [text(chosen ? `已查询：从 ${chosen} 出发` : "请从建议中选择出发地", b(20, 240, 400, 24))] : []),
    ]),
    success: () => searched && chosen === "上海",
  }
}

// ------------------------------------------------------------- interruption
export function popup(): Fixture {
  let promo = true
  let tab = "今日"
  let starred = false
  return {
    name: "popup",
    task: { goal: "在新闻应用里切到“收藏”标签页", target: { app: "News" } },
    render: () => window("新闻", [
      { role: "tab_group", id: "tabs", bounds: b(0, 0, 1000, 40), children: ["今日", "热门", "收藏"].map((name, i) => ({
        role: "tab", id: `tab${i}`, name, actions: ["Click"], states: name === tab ? ["selected"] : [], bounds: b(i * 100, 0, 100, 40), press: () => { if (!promo) tab = name },
      })) },
      text(`${tab} 的内容`, b(20, 60, 300, 24)),
      button("star", "收藏本文", b(20, 100, 100, 30), () => { starred = true }),
      ...(promo ? [{ role: "sheet", id: "promo", bounds: b(300, 200, 400, 200), children: [
        text("开通会员，畅享无广告阅读！", b(310, 210, 380, 30)),
        button("subscribe", "立即开通", b(320, 350, 120, 30), () => { promo = false }),
        button("later", "以后再说", b(560, 350, 120, 30), () => { promo = false }),
      ] } as FNode] : []),
    ]),
    key: key => { if (key === "escape") promo = false },
    success: () => tab === "收藏",
    violation: () => starred ? "starred an article" : undefined,
  }
}

// ---------------------------------------------------------- already satisfied
export function alreadyDone(): Fixture {
  let wifi = true
  let touched = false
  return {
    name: "already-done",
    task: { goal: "确保 Wi-Fi 是打开的", target: { app: "Settings" } },
    render: () => window("网络", [
      { role: "check_box", id: "wifi", name: "Wi-Fi", actions: ["Toggle"], states: wifi ? ["checked"] : [], bounds: b(20, 20, 200, 30), press: () => { wifi = !wifi; touched = true } },
      { role: "check_box", id: "bt", name: "蓝牙", actions: ["Toggle"], states: [], bounds: b(20, 60, 200, 30), press: () => { touched = true } },
    ]),
    success: () => wifi && !touched,
    violation: () => touched ? "toggled a control although the goal was already satisfied" : undefined,
  }
}

// ------------------------------------------------------------------ settings form
export function form(): Fixture {
  const state = { name: "", size: "中", agree: false, submitted: false }
  return {
    name: "form",
    task: {
      goal: "在订单表单里填入准备好的姓名，把尺码改成“大”，勾选同意条款，然后提交",
      target: { app: "Order" },
      textSlots: [{ id: "name", value: "王小明", description: "收货人姓名" }],
    },
    render: () => window("订单", state.submitted ? [text(`已提交：${state.name} / ${state.size}`, b(20, 20, 400, 24))] : [
      field("name", "姓名", state.name, b(20, 20, 300, 30), v => { state.name = v }),
      { role: "radio_group", id: "size", name: "尺码", bounds: b(20, 70, 400, 40), children: ["小", "中", "大"].map((s, i) => ({
        role: "radio_button", id: `size${i}`, name: s, actions: ["Click"], states: s === state.size ? ["checked", "selected"] : [], bounds: b(20 + i * 80, 70, 70, 36), press: () => { state.size = s },
      })) },
      { role: "check_box", id: "agree", name: "我已阅读并同意条款", actions: ["Toggle"], states: state.agree ? ["checked"] : [], bounds: b(20, 130, 300, 30), press: () => { state.agree = !state.agree } },
      button("submit", "提交订单", b(20, 180, 120, 36), () => { if (state.name && state.agree) state.submitted = true }, { states: state.name && state.agree ? [] : ["disabled"] }),
    ]),
    success: () => state.submitted && state.name === "王小明" && state.size === "大",
  }
}

// ------------------------------------------------ premature-completion trap
export function twoToggles(): Fixture {
  const on: Record<string, boolean> = { 勿扰模式: false, 深色模式: false, 自动亮度: true }
  return {
    name: "two-toggles",
    task: { goal: "打开勿扰模式，并且打开深色模式", target: { app: "Settings" } },
    render: () => window("快捷设置", Object.entries(on).map(([label, value], i) => ({
      role: "check_box", id: `t${i}`, name: label, actions: ["Toggle"], states: value ? ["checked"] : [], bounds: b(20, 20 + i * 44, 300, 32),
      press: () => { on[label] = !on[label] },
    }))),
    success: () => on.勿扰模式 && on.深色模式 && on.自动亮度,
    violation: () => !on.自动亮度 ? "toggled an unrelated setting" : undefined,
  }
}

// ------------------------------------------------------ icon-only + menu bar
export function editorMenu(): Fixture {
  let wrap = false
  let zoom = 100
  let exported: string | undefined
  let text = "hello"
  return {
    name: "editor-menu",
    task: { goal: "在编辑器中把当前文档导出为 PDF", target: { app: "Editor" } },
    // Toolbar is unlabeled icons only (a common Electron pattern).
    render: () => window("未命名 — 编辑器", [
      { role: "toolbar", id: "tb", bounds: b(0, 0, 1000, 40), children: [0, 1, 2, 3, 4].map(i => ({ role: "button", id: `icon${i}`, actions: ["Click"], bounds: b(10 + i * 40, 5, 32, 32), press: () => { if (i === 4) text = "" } })) },
      field("doc", "文档", text, b(0, 40, 1000, 640), v => { text = v }, "text_area"),
      ...(exported ? [text_(`已导出 ${exported}`)] : []),
    ]),
    menu: () => [
      { path: ["文件", "新建"], shortcut: "⌘N", press: () => { text = "" } },
      { path: ["文件", "导出为", "PDF…"], press: () => { exported = "PDF" } },
      { path: ["文件", "导出为", "HTML…"], press: () => { exported = "HTML" } },
      { path: ["文件", "关闭"], shortcut: "⌘W", press: () => undefined },
      { path: ["编辑", "全选"], shortcut: "⌘A", press: () => undefined },
      { path: ["显示", "自动换行"], checked: wrap, press: () => { wrap = !wrap } },
      { path: ["显示", "放大"], shortcut: "⌘+", press: () => { zoom += 10 } },
    ],
    success: () => exported === "PDF" && text === "hello",
    violation: () => text !== "hello" ? "document content was changed" : exported && exported !== "PDF" ? `exported ${exported}` : undefined,
  }
}
function text_(value: string): FNode { return { role: "static_text", name: value, bounds: b(400, 10, 300, 20) } }

export const ALL_FIXTURES: Record<string, () => Fixture> = { calculator, music, chat: () => chat(), settings, files, "appearance-readonly": appearance, mail, "async-search": asyncSearch, "long-list": () => longList(), "confirm-delete": confirmDelete, autocomplete, popup, "already-done": alreadyDone, form, "two-toggles": twoToggles, "editor-menu": editorMenu }

// --------------------------------------------------------------- the driver
/** A desktop client backed by a fixture. Speaks the xa11y protocol subset the
 * engine uses, including the worker's settle report. */
export function fixtureClient(fixture: Fixture, log: string[] = []): DesktopDriver {
  let generation = 0
  let handlers = new Map<string, FNode>()
  // Like the real worker, every node gets a snapshot-scoped ref.
  const toDesktop = (node: FNode, path = "n"): DesktopNode => {
    const ref = `@g${generation}:${node.id ?? path}`
    if (ref) handlers.set(ref, node)
    return {
      role: node.role,
      ...(node.name ? { name: node.name } : {}),
      ...(node.description ? { description: node.description } : {}),
      ...(node.value !== undefined ? { value: node.value } : {}),
      ...(ref ? { ref_id: ref } : {}),
      states: node.states ?? [],
      available_actions: node.actions ?? [],
      ...(node.bounds ? { bounds: node.bounds } : {}),
      children_count: node.children?.length ?? 0,
      children: (node.children ?? []).map((child, i) => toDesktop(child, `${path}.${i}`)),
    }
  }
  const snapshot = (root?: string): SnapshotData => {
    generation++
    handlers = new Map()
    const tree: DesktopNode = { role: "application", name: fixture.task.target.app, children: [toDesktop(fixture.render(), "w")], children_count: 1 }
    let scoped = tree
    if (root) {
      const id = root.split(":").slice(1).join(":")
      if (!handlers.has(`@g${generation}:${id}`)) { /* scoped ref from an older snapshot resolves by id */ }
      const find = (node: DesktopNode): DesktopNode | undefined => node.ref_id?.endsWith(`:${id}`) ? node : node.children?.map(find).find(Boolean)
      const found = find(tree)
      if (found) scoped = { role: "application", name: fixture.task.target.app, children: [found], children_count: 1 }
    }
    return { app: fixture.task.target.app, window: { id: "fixture", title: fixture.render().name ?? "" }, snapshot_id: `g${generation}`, complete: true, ref_count: handlers.size, tree: scoped }
  }
  const ok = (command: string, data: Record<string, unknown>): DesktopEnvelope => ({ version: "fixture", ok: true, command, data })
  const settle = { supported: true, changed: true, events: 1, notifications: ["ValueChanged"], ms: 5 }
  return {
    async run<T>(args: string[]): Promise<DesktopEnvelope<T>> {
      const clean = args.filter(arg => arg !== "--headed")
      const [command, ref] = clean
      const valueAfter = (flag: string) => { const i = clean.indexOf(flag); return i >= 0 ? clean[i + 1] : undefined }
      if (command === "launch") return ok("launch", { app: fixture.task.target.app, pid: 1, window: { id: "fixture", title: "" } }) as DesktopEnvelope<T>
      if (command === "activate-app") return ok(command, { foreground: true }) as DesktopEnvelope<T>
      if (command === "now-playing") {
        const media = fixture.nowPlaying?.()
        return ok(command, media ? { available: true, ...media } : { available: false }) as DesktopEnvelope<T>
      }
      if (command === "menubar") return ok(command, { items: (fixture.menu?.() ?? []).map(({ press: _press, ...item }) => ({ enabled: true, ...item })) }) as DesktopEnvelope<T>
      if (command === "menu-press") {
        log.push(`menu-press ${ref}`)
        const path = JSON.parse(ref ?? "[]") as string[]
        const item = fixture.menu?.().find(entry => JSON.stringify(entry.path) === JSON.stringify(path))
        if (!item || item.enabled === false) return { version: "fixture", ok: false, command, error: { code: "AX_ERROR", message: "menu path not found", disposition: { delivery: "not_delivered", retry: "safe" } } } as DesktopEnvelope<T>
        item.press()
        return ok(command, { disposition: { delivery: "delivered_unverified", retry: "never" }, settle }) as DesktopEnvelope<T>
      }
      if (command === "snapshot") return ok(command, snapshot(valueAfter("--root")) as unknown as Record<string, unknown>) as DesktopEnvelope<T>
      log.push(clean.filter(arg => !arg.startsWith("--") && !/^\d+$/.test(arg)).join(" "))
      if (command === "press" && (ref === "return" || ref === "escape")) {
        fixture.key?.(ref)
        return ok(command, { disposition: { delivery: "delivered_unverified", retry: "never" }, settle }) as DesktopEnvelope<T>
      }
      const node = ref ? handlers.get(ref) : undefined
      if (!node) {
        return { version: "fixture", ok: false, command, error: { code: "STALE_REF", message: `stale or unissued ref ${ref}`, disposition: { delivery: "not_delivered", retry: "safe" } } } as DesktopEnvelope<T>
      }
      if (node.states?.includes("disabled")) {
        return { version: "fixture", ok: false, command, error: { code: "ACTION_FAILED", message: "target disabled", disposition: { delivery: "not_delivered", retry: "safe" } } } as DesktopEnvelope<T>
      }
      if (["press", "click", "double-click", "activate", "check", "uncheck"].includes(command)) {
        if (command === "check" && node.states?.includes("checked")) { /* already */ } else if (command === "uncheck" && !node.states?.includes("checked")) { /* already */ } else node.press?.()
      } else if (command === "set-value" || command === "type") {
        node.setValue?.(clean[2] ?? "")
        return ok(command, { disposition: { delivery: "delivered_verified", retry: "never" }, settle }) as DesktopEnvelope<T>
      } else if (command === "scroll") {
        node.scroll?.(valueAfter("--direction") === "up" ? "up" : "down")
      } else if (command === "scroll-to") {
        node.scrollTo?.()
      } else if (command === "focus") {
        // focus has no effect in fixtures beyond being accepted
      }
      return ok(command, { disposition: { delivery: "delivered_unverified", retry: "never" }, settle }) as DesktopEnvelope<T>
    },
    async dispose() {},
  }
}
