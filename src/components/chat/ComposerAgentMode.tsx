import { memo, type ReactNode } from "react";
import { gooeyToast } from "goey-toast";
import { setComputerUseMode, setMultiAgentMode, report } from "../../lib/rpc";
import { useWorkspace } from "../../lib/store";
import { Icon } from "../Icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "../UI";

/** 开关只有开/关两态，两个模式的说明留给 tooltip。 */
const modes = [
  { hint: "单线工作流，由一个助手顺序处理" },
  { hint: "分支工作流，可委派多个子 agent 并行处理" },
] as const;

function ModeTooltip({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return <Tooltip>
    <TooltipTrigger render={<span className="composer-mode-tooltip" />}>
      {children}
    </TooltipTrigger>
    <TooltipContent>{hint || label}</TooltipContent>
  </Tooltip>;
}

function ComposerAgentModeImpl() {
  const enabled = useWorkspace(state => state.multiAgentEnabled);
  const computerUse = useWorkspace(state => state.computerUseEnabled);
  const online = useWorkspace(state => state.connection === "online");
  const running = useWorkspace(state => state.transcript.running);
  const desktop = useWorkspace(state => state.runtimeTarget === "desktop");
  const macos = useWorkspace(state => state.runtimePlatform === "macos");
  const locked = running ? "任务运行中不可切换" : "";
  return <div className="composer-session-modes">
    <ModeTooltip label="多 agent" hint={locked || modes[enabled ? 1 : 0].hint}>
      <button type="button" className={`composer-mode-toggle${enabled ? " selected" : ""}`} aria-label="多 agent 协作" aria-pressed={enabled} disabled={!online || running} onClick={() => void setMultiAgentMode(!enabled).catch(report)}>
        <Icon name="tree-structure" className="composer-mode-icon" />
      </button>
    </ModeTooltip>
    {desktop && macos && <ModeTooltip label="电脑操作" hint={locked || (computerUse ? "电脑操作已开启，直接说要打开的网页或 App 即可" : "开启后可用自然语言让助手点选本机界面")}>
      <button type="button" className={`composer-mode-toggle${computerUse ? " selected" : ""}`} aria-label="电脑操作" aria-pressed={computerUse} disabled={!online || running} onClick={() => void setComputerUseMode(!computerUse).then(() => gooeyToast.success(computerUse ? "电脑操作已关闭" : "电脑操作已开启，直接说要做什么即可", { showTimestamp: false })).catch(report)}>
        <Icon name="desktop" className="composer-mode-icon" />
      </button>
    </ModeTooltip>}
  </div>;
}

export const ComposerAgentMode = memo(ComposerAgentModeImpl);
