import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useWorkspace } from "../../lib/store";
import { Icon } from "../Icon";
import { DesktopHostSettings, MobileAccessSettings } from "./GeneralSettingsPanel";

/** Standalone entry point for the desktop-to-phone connection controls. */
export function MobileAccessPanel() {
  const desktop = useWorkspace(state => state.runtimeTarget !== "mobile");
  const [version, setVersion] = useState("");
  useEffect(() => { void getVersion().then(setVersion).catch(() => undefined); }, []);
  return <div className="mobile-access-panel">
      <div className="panel-heading">
        <div>
          <h1><Icon name="device-mobile" />移动端</h1>
        </div>
      <span className="mobile-access-version" aria-label={version ? `当前版本 ${version}` : "当前版本"}>当前版本{version ? ` ${version}` : " —"}</span>
    </div>
    {desktop ? <DesktopHostSettings pageMode /> : <section className="mobile-access-surface" aria-label="手机连接"><MobileAccessSettings /></section>}
  </div>;
}

export default MobileAccessPanel;
