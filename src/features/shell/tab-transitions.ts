/**
 * 标签切换期间的三份「隐式状态」，显式成一个小对象。
 *
 * 壳层在做「把某个面放到屏幕上」这件事时，本来有三处不变量是靠模块级集合 +
 * 注释维持的，代码里到处是 `if (map.get(...))` / `try { await } finally { map.delete }`：
 *
 * 1. `showing`：正在显示的面，按 `工作区:范围` 去重。首页的 effect 与控制器可能在
 *    同一帧里都要显示首页；不去重的话两边各算一个随机连接 id，会白起一条 pi 进程
 *    并闪一下。
 * 2. `starting`：正在启动的连接，按连接 target 去重。同一个槽位不能被并发 `show`
 *    拉起两次，否则第二条 pi 进程会挂在同一个 session 上。
 * 3. `closing`：正在被放弃的连接（用户关了标签页、面板，或范围切换把它换掉了）。
 *    `closeConnection` 只有在会话空闲时才同步从 `connections` 里消失；会话还在跑/
 *    压缩时它先 `clear_queue` + `abort`（最长 60s），这期间连接仍然是「活着的孤儿」。
 *    对账（`reconcileOrphans`）救的是真正的孤儿，但它分不清「没人要了」和「正在关」
 *    —— 于是每次关标签页都会再把同一条连接收养回一个新标签页，表现就是标签页关不完。
 *
 * 三者都是「有生命周期的登记表」：登记 → 完成/失败 → 自动注销。以前这份生命周期
 * 散在调用点上（每个 `await` 都配一个 `finally`），漏一个就是内存里的幽灵条目：
 * 那条 target 从此再也不会被重新启动。这里把它收成一处，语义写成文档。
 *
 * 这个模块**不碰**任何 store、连接或 React：它只记账，调用方决定什么时候登记。
 * 因此可以 instance 化（测试各拿一份，互不污染），`use-workspace-tabs.ts` 里用的是
 * 一个模块级单例。
 */

/** 一次 `show` 的 key：`工作区id:范围cwd`。 */
export type ShowKey = string;
/** 一次启动的 key：连接 target id。 */
export type StartTarget = string;
/** 一条正在被放弃的连接 id。 */
export type ClosingId = string;

export type TabTransitions = {
  /**
   * 显示一个面：同一 `key` 已经有在飞的任务时直接复用（返回**同一个** promise），
   * 否则执行 `task` 并登记，等它 settle（成功或失败）后自动注销。
   *
   * 用 thunk 而不是 promise，是为了让「去重判定」发生在建连接之前：
   * 重复调用根本不应该产生一次副作用。
   */
  show(key: ShowKey, task: () => Promise<void>): Promise<void>;
  /** 这个 key 现在有没有在飞的 `show`。 */
  isShowing(key: ShowKey): boolean;
  /** 这个 key 正在飞的那个 promise（没有则 `undefined`）；给需要 `await` 它的调用方。 */
  inFlightShow(key: ShowKey): Promise<void> | undefined;

  /**
   * 启动一条连接：同一 `target` 已经在飞时，`pendingStart` 返回那个 promise，
   * 调用方可以 `await` 它（等别人把连接拉起来）而不是自己再拉一遍。
   */
  pendingStart(target: StartTarget): Promise<void> | undefined;
  /** 这个 target 现在有没有在飞的启动。 */
  isStarting(target: StartTarget): boolean;
  /** 登记一次启动；同一 target 并发时返回已有的 in-flight promise。settle 后自动注销。 */
  start(target: StartTarget, task: Promise<void>): Promise<void>;

  /**
   * 标记一条连接「正在被放弃」。标记之后对账不能再把它当孤儿收养。
   * 与 `markClosing` 配对的清理是 `unmarkClosing`（历史上是 `closing.add` +
   * `retireConnection` 的 `finally` 里的 `closing.delete`）。
   */
  markClosing(id: ClosingId): void;
  /** 连接真的关完了（或决定不关了）：解除标记，否则它既关不掉也不会再被收养。 */
  unmarkClosing(id: ClosingId): void;
  /** 这条连接是不是正在被放弃。 */
  isClosing(id: ClosingId): boolean;
  /** 当前所有「正在被放弃」的连接，调试/测试用。 */
  closingIds(): ClosingId[];

  /** 三份登记表的当前大小，调试/测试用。 */
  counts(): { showing: number; starting: number; closing: number };
};

/**
 * 登记 `task()` 返回的 promise，并在它 settle 后注销。
 *
 * 注销前比对同一个 promise：假如同一个 key 上已经有新的一轮登记（前一轮 settle
 * 之后立刻又开始），旧一轮的清理绝不能把新一轮的条目删掉——否则那个 key 会在
 * 新一轮还在飞的时候被当成「空闲」，下一帧又起一条连接。
 */
function track<V>(
  registry: Map<string, Promise<V>>,
  key: string,
  task: () => Promise<V>,
): Promise<V> {
  const existing = registry.get(key);
  if (existing) return existing;
  let tracked: Promise<V>;
  tracked = task().finally(() => {
    if (registry.get(key) === tracked) registry.delete(key);
  });
  registry.set(key, tracked);
  return tracked;
}

/** 建一份独立的切换状态机。测试各拿一份；壳层只要一个单例。 */
export function createTabTransitions(): TabTransitions {
  const showing = new Map<ShowKey, Promise<void>>();
  const starting = new Map<StartTarget, Promise<void>>();
  const closing = new Set<ClosingId>();

  return {
    show(key, task) {
      return track(showing, key, task);
    },

    isShowing(key) {
      return showing.has(key);
    },

    inFlightShow(key) {
      return showing.get(key);
    },

    pendingStart(target) {
      return starting.get(target);
    },

    isStarting(target) {
      return starting.has(target);
    },

    start(target, task) {
      const inFlight = starting.get(target);
      if (inFlight) {
        // 已经有人在拉这条连接：本次的 task 不接管（`use-workspace-tabs` 的调用点
        // 会先问 `pendingStart`，所以正常路径到不了这里）。挂一个 catch，免得这条
        // 被弃用的 promise reject 时变成未处理的拒绝。
        void task.catch(() => undefined);
        return inFlight;
      }
      let tracked: Promise<void>;
      tracked = task.finally(() => {
        if (starting.get(target) === tracked) starting.delete(target);
      });
      starting.set(target, tracked);
      return tracked;
    },

    markClosing(id) {
      if (!id) return;
      closing.add(id);
    },

    unmarkClosing(id) {
      closing.delete(id);
    },

    isClosing(id) {
      return closing.has(id);
    },

    closingIds() {
      return [...closing];
    },

    counts() {
      return { showing: showing.size, starting: starting.size, closing: closing.size };
    },
  };
}
