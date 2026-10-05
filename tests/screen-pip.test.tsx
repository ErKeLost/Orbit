/**
 * What the floating window is, checked by rendering it.
 *
 * These assertions exist because "the control is there but does nothing" is the
 * failure mode that keeps surviving review: a handler wired to the wrong setter,
 * a prop the library ignores, a footer that renders without data. Rendering the
 * component catches all of those without a phone.
 *
 * The window is rendered on the server (`renderToStaticMarkup`), so this cannot
 * simulate a drag — it verifies the structure and the props that make the
 * gestures possible, not the gestures themselves.
 */
import { describe, expect, test } from "bun:test"

// A viewport and a storage area, defined before anything reads them: the
// geometry is a pure function of the visual viewport, so a component that
// measures one cannot be imported without one.
const globals = globalThis as unknown as Record<string, unknown>
globals.window ??= {
  innerWidth: 390,
  innerHeight: 844,
  devicePixelRatio: 3,
  visualViewport: { offsetLeft: 0, offsetTop: 0, width: 390, height: 844, addEventListener() {}, removeEventListener() {} },
  addEventListener() {},
  removeEventListener() {},
}
globals.localStorage ??= {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
}

const { renderToStaticMarkup } = await import("react-dom/server")
const { ScreenPip } = await import("../src/components/screen/ScreenPip")
const { ScreenFrame } = await import("../src/components/screen/ScreenFrame")
const { pipBox, currentViewport, minWidth, maxWidth } = await import("../src/lib/screen-pip")

const viewport = currentViewport()

function snapshot(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    state: "live",
    error: null,
    codec: "h264",
    codecNote: null,
    webCodecs: true,
    displays: [],
    display: { id: 1, name: "主显示器", kind: "display", ownerPid: null, logicalX: 0, logicalY: 0, logicalWidth: 1728, logicalHeight: 1117, pixelWidth: 3456, pixelHeight: 2234, scale: 2, primary: true },
    frameUrl: null,
    frame: { seq: 4, width: 1728, height: 1117, bytes: 40000, capturedAt: 1, receivedAt: 2, keyframe: true },
    status: null,
    receivedFps: 30,
    latencyMs: 12,
    decodeRecoveries: 0,
    decodeQueue: 0,
    fpsNote: null,
    ...overrides,
  } as never
}

function render(placement: Record<string, unknown>, snap = snapshot()) {
  return renderToStaticMarkup(
    <ScreenPip
      snapshot={snap}
      placement={{ x: -1, y: -1, width: 300, height: -1, ...placement } as never}
      onPlacement={() => undefined}
    />,
  )
}

describe("floating screen window", () => {
  test("renders the eight resize handles that make it resizable", () => {
    const html = render({})
    // A handle is identifiable by its resize cursor, which is what makes it one.
    // Without them the window drags but cannot be resized, which is what a
    // missing `enableResizing` looks like at runtime.
    // Edges report `row`/`col`, corners report a diagonal; both are handles.
    const handles = html.match(/cursor:(?:row|col|[ns][ew]|[ns]|[ew])-resize/g) ?? []
    // 左下角已移除（只保留右下角一个可见角标），其余 7 个仍可拖。
    expect(handles.length).toBe(7)
    // The bottom-right corner gets a real touch target rather than the library's
    // 10px default, which is not a phone target.
    const grips = html.match(/class="screen-pip-grip" style="[^"]*width:28px;height:28px/g) ?? []
    expect(grips.length).toBe(1)
  })

  test("honours a stored size instead of a preset", () => {
    // The window is free-form: a width from storage must reach the element.
    expect(render({ width: 250 })).toContain("width:250px")
    expect(render({ width: 300 })).toContain("width:300px")
    // The bounds reach the element too, so the library clamps while dragging.
    const html = render({ width: 300 })
    expect(html).toContain(`min-width:${minWidth(viewport)}px`)
    expect(html).toContain(`max-width:${maxWidth(viewport)}px`)
  })

  test("clamps a stored size into the allowed range", () => {
    const tiny = render({ width: 10 })
    expect(tiny).toContain(`width:${minWidth(viewport)}px`)
    const huge = render({ width: 5000 })
    expect(huge).toContain(`width:${maxWidth(viewport)}px`)
  })

  test("keeps a stored position inside the visible area", () => {
    const box = pipBox(-1, -1, 300, 220, viewport)
    const html = render({ width: 300, height: 220 })
    expect(html).toContain(`translate(${box.left}px,${box.top}px)`)
    // An out-of-range stored position is corrected rather than trusted.
    const stray = render({ width: 300, height: 220, x: 99999, y: -99999 })
    expect(stray).toContain(`translate(${box.left}px,${box.top}px)`)
  })

  test("shows numbers only once there is a picture", () => {
    // A line of status text parked at the bottom of a small window is both noise
    // and invisible at a glance; failures are toasts instead.
    const withFrame = render({})
    expect(withFrame).toContain("1728×1117")
    expect(withFrame).toContain("30.0 fps")
    const withoutFrame = render({}, snapshot({ frame: null }))
    expect(withoutFrame).not.toContain("fps")
    expect(withoutFrame).not.toContain("重连")
    expect(withoutFrame).not.toContain("等待画面")
  })

  test("the picture letterboxes inside a free-form box", () => {
    // A resizable window is not picture-shaped, so the stage fills the box and
    // the picture is contained — and the touch mapping computes that contain box
    // rather than assuming it fills the container.
    const filling = renderToStaticMarkup(<ScreenFrame snapshot={snapshot()} interactive={false} fill />)
    expect(filling).toContain("data-fill")
    expect(filling).not.toContain("aspect-ratio")
    const aspect = renderToStaticMarkup(<ScreenFrame snapshot={snapshot()} interactive={false} />)
    expect(aspect).toContain("aspect-ratio")
  })
})
