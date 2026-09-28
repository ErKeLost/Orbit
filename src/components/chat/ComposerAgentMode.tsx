import { memo, type ReactNode } from "react";
import { m } from "motion/react";
import { gooeyToast } from "goey-toast";
import { setComputerUseMode, setMultiAgentMode, report } from "../../lib/rpc";
import { useWorkspace } from "../../lib/store";
import { Icon } from "../Icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "../UI";

const modes = [
  { multiAgent: false, label: "标准模式", icon: "flow-arrow", hint: "单线工作流，由一个助手顺序处理" },
  { multiAgent: true, label: "协作模式", icon: "tree-structure", hint: "分支工作流，可委派多个子 agent 并行处理" },
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
    <div className="composer-agent-mode" role="group" aria-label="执行模式">
      {modes.map(({ multiAgent, label, icon, hint }) => {
        const selected = enabled === multiAgent;
        return <ModeTooltip key={label} label={label} hint={locked || hint}>
          <button type="button" className={selected ? "selected" : ""} aria-label={label} aria-pressed={selected} disabled={!online || running} onClick={() => { if (!selected) void setMultiAgentMode(multiAgent).catch(report); }}>
            {selected && <m.span layoutId="composer-agent-mode-indicator" className="composer-agent-mode-indicator" transition={{ type: "spring", stiffness: 520, damping: 38 }} />}
            <span className="composer-agent-mode-content">
              <Icon name={icon} className="composer-agent-mode-icon" />
            </span>
          </button>
        </ModeTooltip>;
      })}
    </div>
    {desktop && macos && <ModeTooltip label="电脑操作" hint={locked || (computerUse ? "电脑操作已开启，直接说要打开的网页或 App 即可" : "开启后可用自然语言让助手点选本机界面")}>
      <button type="button" className={`composer-computer-use${computerUse ? " selected" : ""}`} aria-label="电脑操作" aria-pressed={computerUse} disabled={!online || running} onClick={() => void setComputerUseMode(!computerUse).then(() => gooeyToast.success(computerUse ? "电脑操作已关闭" : "电脑操作已开启，直接说要做什么即可", { showTimestamp: false })).catch(report)}>
        <Icon name="desktop" className="composer-agent-mode-icon" />
      </button>
    </ModeTooltip>}
  </div>;
}

export const ComposerAgentMode = memo(ComposerAgentModeImpl);
