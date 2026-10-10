/**
 * 切换会话时的骨架屏（`transcript.loading`）。
 *
 * 这个开关只有一条清路：`hydrate` 换上一份真正的 transcript。任何一条把旧会话
 * 的内容留在原地、或者把骨架屏留死的路径，都会表现成「点会话之后一直转圈」或者
 * 「先看到上一个会话再突然被抽掉」——所以这里把开关的语义钉住。
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptSkeleton } from "../src/features/chat/Transcript";
import { emptyTranscript, hydrate, reduceEvent, transcriptLoading, type Event } from "../src/lib/protocol";

const loaded = hydrate([{ role: "user", content: "你好", timestamp: 1 }]);

describe("transcript loading flag", () => {
  test("a fresh transcript is not loading", () => {
    expect(emptyTranscript().loading).toBe(false);
  });

  test("set and clear keep the rest of the transcript intact", () => {
    const loading = transcriptLoading(loaded, true);
    expect(loading.loading).toBe(true);
    expect(loading.messages).toBe(loaded.messages);

    const cleared = transcriptLoading(loading, false);
    expect(cleared.loading).toBe(false);
    expect(cleared.messages).toBe(loaded.messages);
  });

  test("writing the value it already has returns the same object", () => {
    // 每帧的流式提交按引用比较，无意义的改写会让整个面板重渲染。
    expect(transcriptLoading(loaded, false)).toBe(loaded);
    const loading = transcriptLoading(loaded, true);
    expect(transcriptLoading(loading, true)).toBe(loading);
  });

  test("hydrate is what clears it", () => {
    const loading = transcriptLoading(loaded, true);
    expect(hydrate([{ role: "user", content: "另一个会话", timestamp: 2 }]).loading).toBe(false);
    // 加载期间到达的事件不会替 hydrate 收尾：开关必须留到真正的会话内容到位。
    const events: Event[] = [
      { type: "queue_update", steering: [], followUp: [] },
      { type: "agent_settled" },
      { type: "compaction_end" },
    ];
    expect(events.map((event) => reduceEvent(loading, event).loading)).toEqual([true, true, true]);
  });
});

describe("skeleton placeholder", () => {
  test("announces itself and pulses placeholder rows", () => {
    const html = renderToStaticMarkup(<TranscriptSkeleton />);
    expect(html).toContain("data-transcript-skeleton");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("正在加载会话…");
    expect(html.match(/animate-pulse/g)?.length).toBeGreaterThan(5);
  });

  test("shows no text that could be mistaken for session content", () => {
    const html = renderToStaticMarkup(<TranscriptSkeleton />);
    const visible = html.replace(/<[^>]+>/g, "");
    expect(visible.trim()).toBe("正在加载会话…");
  });
});
