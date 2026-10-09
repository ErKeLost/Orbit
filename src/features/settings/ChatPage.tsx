import { useWorkspace } from "../../lib/store";
import { useMetrics } from "../../hooks/use-metrics";
import { request, report } from "../../lib/rpc";
import { Group, Row, Select, Toggle } from "../../shared/ui/controls";
import { toast } from "../../shared/ui/toast";

/** Orbit's Chat section, backed by Pi's session RPCs. */
export function ChatPage() {
  const online = useWorkspace((state) => state.connection === "online");
  const running = useWorkspace((state) => state.transcript.running);
  const state = useWorkspace((workspace) => workspace.state);
  const { runtime } = useMetrics();

  const apply = async (command: Parameters<typeof request>[0], label: string) => {
    try {
      await request(command, 30000);
      await request({ type: "get_state" }, 30000).then((next) => useWorkspace.getState().set({ state: next as typeof state }));
      toast.success(`${label}已更新`);
    } catch (error) {
      report(error);
    }
  };

  return (
    <>
      <Group title="上下文" description="接近容量时 Pi 如何整理对话。">
        <Row label="自动压缩" description="接近上下文容量时，让 Pi 自动整理较早的内容。">
          <Toggle
            label="自动压缩"
            on={state?.autoCompactionEnabled ?? false}
            disabled={!online || running}
            onChange={(on) => void apply({ type: "set_auto_compaction", enabled: on }, "自动压缩")}
          />
        </Row>
      </Group>
      <Group title="队列" description="回合进行中发来的消息如何交给模型。">
        <Row label="引导消息" description="当前工具调用完成后交给模型。">
          <Select
            label="引导消息模式"
            value={state?.steeringMode ?? "one-at-a-time"}
            disabled={!online}
            options={[
              { value: "one-at-a-time", label: "每次一条" },
              { value: "all", label: "全部送入" },
            ]}
            onChange={(value) => void apply({ type: "set_steering_mode", mode: value as "all" | "one-at-a-time" }, "引导消息模式")}
          />
        </Row>
        <Row label="跟进消息" description="本轮任务全部结束后交给模型。">
          <Select
            label="跟进消息模式"
            value={state?.followUpMode ?? "one-at-a-time"}
            disabled={!online}
            options={[
              { value: "one-at-a-time", label: "每次一条" },
              { value: "all", label: "全部送入" },
            ]}
            onChange={(value) => void apply({ type: "set_follow_up_mode", mode: value as "all" | "one-at-a-time" }, "跟进消息模式")}
          />
        </Row>
      </Group>
      <Group title="重试" description="请求失败后的自动恢复策略。">
        <Row label="自动重试" description="传输或提供商出错时按退避间隔自动重试。">
          <Toggle
            label="自动重试"
            on={runtime?.retry.enabled ?? false}
            disabled={!online}
            onChange={(on) => void apply({ type: "set_auto_retry", enabled: on }, "自动重试")}
          />
        </Row>
      </Group>
    </>
  );
}
