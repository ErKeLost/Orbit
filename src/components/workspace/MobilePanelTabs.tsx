import type { Panel } from "../../lib/store";
import { Icon } from "../Icon";
import { Button } from "../UI";

/**
 * The views a phone actually switches between, in the order they matter.
 *
 * This is the narrow-screen counterpart of the sidebar: on a phone the drawer
 * is two taps away, and the whole point of the screen channel is flipping
 * between "what the agent is doing" and "watching it do it". Keeping the list
 * short and horizontal-swipeable is what makes that one tap.
 */
const TABS: { id: Panel; label: string; icon: string }[] = [
  { id: "chat", label: "对话", icon: "chat-circle-text" },
  { id: "screen", label: "屏幕", icon: "desktop" },
  { id: "sessions", label: "会话", icon: "chats" },
  { id: "changes", label: "变更", icon: "git-commit" },
  { id: "commands", label: "命令", icon: "puzzle-piece" },
];

export function MobilePanelTabs({ panel, onNavigate }: { panel: Panel; onNavigate: (panel: Panel) => void }) {
  // A panel opened from the drawer (settings, mobile access, the console) is
  // not in the strip, so nothing would read as selected. Marking the strip as
  // "elsewhere" is more honest than highlighting a tab that is not showing.
  const inStrip = TABS.some(tab => tab.id === panel);
  return <nav className="mobile-panel-tabs" aria-label="视图切换" data-detached={!inStrip}>
    {TABS.map(tab => <Button
      key={tab.id}
      className={`mobile-panel-tab ${panel === tab.id ? "selected" : ""}`}
      onClick={() => onNavigate(tab.id)}
      aria-current={panel === tab.id ? "page" : undefined}
    >
      <Icon name={tab.icon} />
      <span>{tab.label}</span>
    </Button>)}
  </nav>;
}
