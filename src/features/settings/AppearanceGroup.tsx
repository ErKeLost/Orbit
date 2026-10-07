import { useAppearance, type ThemePreference } from "../../lib/appearance";
import { Group, Row, Segmented, Slider } from "../../shared/ui/controls";

/** MonoCode's Appearance page, condensed into one card: scheme + tint. */
export function AppearanceGroup() {
  const { preference, hue, saturation, darkLightness, sidebarOpacity, setPreference, setTint } = useAppearance();
  return (
    <Group title="外观" description="和 MonoCode 一样，整套界面只由一个色相、饱和度和亮度推导出来。">
      <Row label="配色">
        <Segmented<ThemePreference>
          label="配色"
          value={preference}
          options={[
            { value: "system", label: "跟随系统" },
            { value: "light", label: "浅色" },
            { value: "dark", label: "深色" },
          ]}
          onChange={setPreference}
        />
      </Row>
      <Row label="色相" description="窗口与侧栏的底色色调。">
        <Slider label="色相" value={hue} display={`${hue}°`} min={0} max={360} onChange={(value) => setTint({ hue: value })} />
      </Row>
      <Row label="饱和度">
        <Slider label="饱和度" value={saturation} display={`${saturation}%`} min={0} max={40} onChange={(value) => setTint({ saturation: value })} />
      </Row>
      <Row label="深色亮度" description="只影响深色模式的背景。">
        <Slider label="深色亮度" value={darkLightness} display={`${darkLightness}%`} min={0} max={20} onChange={(value) => setTint({ darkLightness: value })} />
      </Row>
      <Row label="侧栏不透明度">
        <Slider label="侧栏不透明度" value={Math.round(sidebarOpacity * 100)} display={`${Math.round(sidebarOpacity * 100)}%`} min={15} max={100} onChange={(value) => setTint({ sidebarOpacity: value / 100 })} />
      </Row>
    </Group>
  );
}
