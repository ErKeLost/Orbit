import { useEffect, useState } from "react";
import { getRequestBudget, saveRequestBudget } from "../../lib/rpc-projects";
import { report } from "../../lib/rpc";
import { Group, Row, Select } from "../../shared/ui/controls";
import { toast } from "../../shared/ui/toast";

/** Pi's default when the file says nothing; the two must agree (see `request-budget.ts`). */
const DEFAULT_MAX_IMAGES = 10;

const CHOICES = [
  { value: "4", label: "4 张" },
  { value: "6", label: "6 张" },
  { value: "10", label: "10 张（默认）" },
  { value: "15", label: "15 张" },
  { value: "30", label: "30 张" },
  { value: "0", label: "不限制" },
];

/**
 * 历史图片上限。
 *
 * 上下文每轮都整段重发，所以一张旧截图会在之后的每一次提问里再上传一遍 —— 模型首字
 * 延迟里能省下来的那一块就是它。默认只带最近 10 张：更早的换成一行占位文本，会话
 * 历史、磁盘上的 session 文件和界面里的图都不动，下一轮还能调大再拿回来。
 *
 * 配置落在 `~/.pi/agent/request-budget.json`，由 Pi 会话里的 `resources/request-budget.ts`
 * 在每次请求前读取，所以保存后下一轮就生效，不需要重连或重启。
 */
export function ImageHistorySettings() {
  const [maxImages, setMaxImages] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void getRequestBudget()
      .then(({ settings }) => {
        if (live) setMaxImages(settings.maxImages ?? DEFAULT_MAX_IMAGES);
      })
      .catch(() => live && setMaxImages(DEFAULT_MAX_IMAGES));
    return () => { live = false; };
  }, []);

  const commit = async (value: number) => {
    const previous = maxImages;
    setMaxImages(value);
    setBusy(true);
    try {
      const saved = await saveRequestBudget({ maxImages: value });
      setMaxImages(saved.settings.maxImages ?? value);
      toast.success("图片上限已保存", { description: "下一轮请求生效", showTimestamp: false });
    } catch (error) {
      // 写失败就回到原值：下拉框停在新值而文件没变，是更难解释的那种状态。
      setMaxImages(previous);
      report(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group title="图片" description="上下文每轮都会整段重发，旧截图也一样在上传。">
      <Row label="历史图片上限" description="只带最近的几张图片，更早的换成一行占位文本（历史记录里的图不删）。">
        <Select
          label="历史图片上限"
          value={String(maxImages ?? DEFAULT_MAX_IMAGES)}
          disabled={busy || maxImages === null}
          options={CHOICES}
          onChange={(value) => void commit(Number(value))}
        />
      </Row>
    </Group>
  );
}
