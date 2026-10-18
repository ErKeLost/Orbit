import { describe, expect, test } from "bun:test";
import { createTabTransitions } from "../src/features/shell/tab-transitions";

/**
 * `tab-transitions.ts` 是「标签切换时哪些事正在飞」的唯一账本。这些用例锁的是
 * 三份登记表的生命周期：登记 → 复用 → settle 后自动注销（成功、失败都要）。
 */

/** 一个可以手动 resolve 的 promise，用来把「在飞」这个窗口撑开。 */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** 让 `.finally` 里的注销跑完（它比 await 的续体更早，但显式刷一遍更稳）。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("show: 同一个面的并发去重", () => {
  test("同 key 并发 show 只跑一次，两次拿到同一个 promise", async () => {
    const transitions = createTabTransitions();
    const gate = deferred();
    let calls = 0;
    const task = () => {
      calls += 1;
      return gate.promise;
    };

    const first = transitions.show("home:/a", task);
    const second = transitions.show("home:/a", task);

    // 同一个 in-flight promise：不是「两个都跑、结果一样」，而是根本只起一次。
    expect(second).toBe(first);
    expect(calls).toBe(1);
    expect(transitions.isShowing("home:/a")).toBe(true);

    gate.resolve();
    await Promise.all([first, second]);
    await flush();
    expect(transitions.isShowing("home:/a")).toBe(false);
    expect(transitions.counts().showing).toBe(0);
  });

  test("不同 key 互不去重", async () => {
    const transitions = createTabTransitions();
    const a = deferred();
    const b = deferred();
    let calls = 0;

    const first = transitions.show("/a:/a", () => {
      calls += 1;
      return a.promise;
    });
    const second = transitions.show("/b:/b", () => {
      calls += 1;
      return b.promise;
    });

    expect(calls).toBe(2);
    expect(second).not.toBe(first);
    expect(transitions.counts().showing).toBe(2);

    a.resolve();
    b.resolve();
    await Promise.all([first, second]);
    await flush();
    expect(transitions.counts().showing).toBe(0);
  });

  test("跑完之后再 show 会重新执行（不缓存结果）", async () => {
    const transitions = createTabTransitions();
    let calls = 0;

    await transitions.show("k", async () => {
      calls += 1;
    });
    await flush();
    expect(transitions.isShowing("k")).toBe(false);

    const gate = deferred();
    let ranAgain = false;
    const again = transitions.show("k", () => {
      ranAgain = true;
      return gate.promise;
    });

    // 第二次是真的又跑了一遍任务，而不是复用上一次的结果。
    expect(ranAgain).toBe(true);
    expect(calls).toBe(1);
    expect(transitions.isShowing("k")).toBe(true);
    gate.resolve();
    await again;
    await flush();
    expect(transitions.counts().showing).toBe(0);
  });

  test("任务抛错也会注销，并且错误原样冒给调用方", async () => {
    const transitions = createTabTransitions();
    const boom = new Error("connect failed");

    await expect(transitions.show("k", () => Promise.reject(boom))).rejects.toThrow("connect failed");
    await flush();
    expect(transitions.isShowing("k")).toBe(false);
    expect(transitions.counts().showing).toBe(0);

    // 失败过一次的 key 必须还能重新显示，否则这个面就永远卡住了。
    const gate = deferred();
    const retry = transitions.show("k", () => gate.promise);
    expect(transitions.isShowing("k")).toBe(true);
    gate.resolve();
    await retry;
  });

  test("pending 期间不会因为上一轮的清理把新一轮的登记删掉", async () => {
    const transitions = createTabTransitions();
    await transitions.show("k", async () => {});
    await flush();
    // 上一轮的 finally 已经跑完；新一轮登记后必须仍然可见。
    const gate = deferred();
    const next = transitions.show("k", () => gate.promise);
    expect(transitions.isShowing("k")).toBe(true);
    expect(transitions.inFlightShow("k")).toBe(next);
    gate.resolve();
    await next;
    await flush();
    expect(transitions.isShowing("k")).toBe(false);
  });
});

describe("start: 同一个 target 的启动去重", () => {
  test("同 target 并发启动只认第一条，pendingStart 给出同一个 promise", async () => {
    const transitions = createTabTransitions();
    const gate = deferred();

    const first = transitions.start("/a#1", gate.promise);
    expect(transitions.isStarting("/a#1")).toBe(true);
    expect(transitions.pendingStart("/a#1")).toBe(first);

    // 第二条同样登记也拿到第一条的 promise，不会自己另起一份。
    const duplicateGate = deferred();
    const second = transitions.start("/a#1", duplicateGate.promise);
    expect(second).toBe(first);

    duplicateGate.resolve();
    gate.resolve();
    await first;
    await flush();
    expect(transitions.isStarting("/a#1")).toBe(false);
    expect(transitions.counts().starting).toBe(0);
  });

  test("启动失败同样会注销（否则这条 target 再也起不来）", async () => {
    const transitions = createTabTransitions();

    const failed = transitions.start("/a#1", Promise.reject(new Error("spawn failed")));
    await expect(failed).rejects.toThrow("spawn failed");
    await flush();
    expect(transitions.isStarting("/a#1")).toBe(false);

    const gate = deferred();
    const retry = transitions.start("/a#1", gate.promise);
    expect(transitions.isStarting("/a#1")).toBe(true);
    gate.resolve();
    await retry;
  });

  test("没有在飞的启动时 pendingStart 是 undefined", () => {
    const transitions = createTabTransitions();
    expect(transitions.pendingStart("/a#1")).toBeUndefined();
  });
});

describe("closing: 正在被放弃的连接", () => {
  test("markClosing 之后 isClosing 为真，unmarkClosing 之后为假", () => {
    const transitions = createTabTransitions();
    const id = "/a#1";

    expect(transitions.isClosing(id)).toBe(false);
    transitions.markClosing(id);
    expect(transitions.isClosing(id)).toBe(true);
    expect(transitions.closingIds()).toEqual([id]);
    expect(transitions.counts().closing).toBe(1);

    transitions.unmarkClosing(id);
    expect(transitions.isClosing(id)).toBe(false);
    expect(transitions.closingIds()).toEqual([]);
  });

  test("重复标记 / 重复解除都是幂等的", () => {
    const transitions = createTabTransitions();
    transitions.markClosing("/a#1");
    transitions.markClosing("/a#1");
    expect(transitions.closingIds()).toEqual(["/a#1"]);
    transitions.unmarkClosing("/a#1");
    transitions.unmarkClosing("/a#1");
    expect(transitions.isClosing("/a#1")).toBe(false);
  });

  test("空 id 不会被登记（调用方偶尔会拿不到 connectionId）", () => {
    const transitions = createTabTransitions();
    transitions.markClosing("");
    expect(transitions.closingIds()).toEqual([]);
  });

  test("多份实例互不影响", async () => {
    const one = createTabTransitions();
    const two = createTabTransitions();
    let calls = 0;
    const gate = deferred();

    const a = one.show("k", () => {
      calls += 1;
      return gate.promise;
    });
    const b = two.show("k", () => {
      calls += 1;
      return gate.promise;
    });
    // 两个独立实例各自登记一次：单例的语义（进程级共享）由调用方决定。
    expect(calls).toBe(2);
    expect(a).not.toBe(b);

    one.markClosing("/a#1");
    expect(two.isClosing("/a#1")).toBe(false);

    gate.resolve();
    await Promise.all([a, b]);
  });
});
