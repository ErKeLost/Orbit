import {
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  m,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react"

type Side = "left" | "right"
type SectionKind = "title" | "subtitle" | "section" | "body"
type SectionLevel = 1 | 2 | 3 | 4 | 5 | 6

export type ProximitySection = {
  id: string
  label: string
  preview?: ReactNode
  previewVersion?: string
  kind?: SectionKind
  level?: SectionLevel
}

type DashPreset = {
  base: number
  bump: number
  thickness: number
  className: string
}

type DashProps = {
  active: boolean
  mouseY: MotionValue<number>
  onSelect: (id: string) => void
  previewsReady: boolean
  registerDash: (id: string, node: HTMLButtonElement | null) => void
  section: ProximitySection
  sectionKind: SectionKind
  side: Side
}

type ProximitySidebarProps = {
  activeOffset?: number
  className?: string
  onSelectSection?: (id: string) => void
  sections: ProximitySection[]
  side?: Side
}

const RADIUS = 28
const MAX_DASH_WIDTH = 36
const SCROLL_IDLE_RESET_DELAY = 80

const DASH_PRESETS: Record<SectionKind, DashPreset> = {
  title: {
    base: 18,
    bump: 10,
    thickness: 1,
    className: "bg-foreground/80",
  },
  subtitle: {
    base: 16,
    bump: 10,
    thickness: 1,
    className: "bg-foreground/70",
  },
  section: {
    base: 12,
    bump: 10,
    thickness: 1,
    className: "bg-muted-foreground/45",
  },
  body: {
    base: 9,
    bump: 9,
    thickness: 1,
    className: "bg-muted-foreground/35",
  },
}

const getSectionElement = (id: string) =>
  typeof document === "undefined" ? null : document.getElementById(id)

const getSectionKind = (section: ProximitySection): SectionKind => {
  if (section.kind) return section.kind
  if (section.level === 1) return "title"
  if (section.level === 2) return "subtitle"
  if (section.level === 3) return "section"
  return "body"
}

const getElementSectionKind = (id: string): SectionKind | undefined => {
  const heading = getSectionElement(id)?.querySelector("h1, h2, h3, h4, h5, h6")
  const tagName = heading?.tagName.toLowerCase()

  if (tagName === "h1") return "title"
  if (tagName === "h2") return "subtitle"
  if (tagName === "h3") return "section"
  if (tagName) return "body"
}

const getScrollParent = (element: HTMLElement) => {
  let parent = element.parentElement

  while (parent) {
    const { overflowY } = window.getComputedStyle(parent)

    if (/(auto|scroll|overlay)/.test(overflowY)) {
      return parent
    }

    parent = parent.parentElement
  }

  return window
}

/** Render the preview bodies only once the browser is idle: they are invisible
 * until a dash is hovered, but mounting all of them up front copies every
 * section's Markdown into the DOM (tens of thousands of nodes in a long
 * session, on the critical path of opening it). */
function useIdleFlag(timeout = 1200) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (ready) return
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(() => setReady(true), { timeout })
      return () => window.cancelIdleCallback(handle)
    }
    const handle = window.setTimeout(() => setReady(true), 200)
    return () => window.clearTimeout(handle)
  }, [ready, timeout])
  return ready
}

function subscribeToScroll(
  parents: Set<EventTarget>,
  listener: EventListener,
) {
  for (const parent of parents) parent.addEventListener("scroll", listener, { passive: true })
  window.addEventListener("resize", listener)
  return () => {
    for (const parent of parents) parent.removeEventListener("scroll", listener)
    window.removeEventListener("resize", listener)
  }
}

const Dash = memo(function Dash({
  active,
  mouseY,
  onSelect,
  previewsReady,
  registerDash,
  section,
  sectionKind,
  side,
}: DashProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const preset = DASH_PRESETS[sectionKind]
  const restWidth = active ? preset.base + Math.round(preset.bump * 0.7) : preset.base
  const activeWidth = preset.base + preset.bump

  useEffect(() => {
    registerDash(section.id, ref.current)
    return () => registerDash(section.id, null)
  }, [registerDash, section.id])

  const distance = useTransform(mouseY, (y) => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return RADIUS
    return y - (rect.top + rect.height / 2)
  })

  const targetScaleX = useTransform(
    distance,
    [-RADIUS, 0, RADIUS],
    [
      restWidth / MAX_DASH_WIDTH,
      activeWidth / MAX_DASH_WIDTH,
      restWidth / MAX_DASH_WIDTH,
    ],
    { clamp: true }
  )

  const scaleX = useSpring(targetScaleX, {
    stiffness: 320,
    damping: 34,
    mass: 0.7,
  })

  return (
    <div className="proximity-item">
      <button
        ref={ref}
        type="button"
        aria-current={active ? "location" : undefined}
        aria-label={`Go to ${section.label}`}
        className="proximity-dash group flex h-2.5 w-9 items-center border-0 bg-transparent p-0 outline-none"
        onClick={() => onSelect(section.id)}
      >
        <m.span
          className={`block transition-colors duration-150 ease-out group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 ${active ? "bg-foreground" : preset.className}`}
          style={{
            height: preset.thickness,
            scaleX,
            transformOrigin: side === "left" ? "left center" : "right center",
            width: MAX_DASH_WIDTH,
          }}
        />
      </button>
      <div className={`proximity-preview proximity-preview-${side}`} role="tooltip">
        <strong>{section.label}</strong>
        {previewsReady && section.preview && <div className="proximity-preview-body">{section.preview}</div>}
      </div>
    </div>
  )
})

const ProximitySidebar = memo(function ProximitySidebar({
  activeOffset = 0.4,
  className = "",
  onSelectSection,
  side = "left",
  sections,
}: ProximitySidebarProps) {
  const visibleSections = useMemo(() => sections.filter(section => section.level === 1 || section.level === 2), [sections])
  const mouseY = useMotionValue(Infinity)
  const shouldReduceMotion = useReducedMotion()
  const dashRefs = useRef(new Map<string, HTMLButtonElement>())
  const pointerInside = useRef(false)
  const resetTimer = useRef<number | null>(null)
  const selectFrame = useRef<number | null>(null)
  const [activeId, setActiveId] = useState(visibleSections[0]?.id)
  const activeIdRef = useRef(activeId)
  const onSelectRef = useRef(onSelectSection)
  onSelectRef.current = onSelectSection
  const previewsReady = useIdleFlag()
  const sectionsRef = useRef(visibleSections)
  useEffect(() => {
    sectionsRef.current = visibleSections
  }, [visibleSections])

  const sectionIds = useMemo(
    () => visibleSections.map((section) => section.id).join("|"),
    [visibleSections]
  )

  const registerDash = useCallback(
    (id: string, node: HTMLButtonElement | null) => {
      if (node) {
        dashRefs.current.set(id, node)
        return
      }

      dashRefs.current.delete(id)
    },
    []
  )

  const clearPendingReset = useCallback(() => {
    if (!resetTimer.current) return

    window.clearTimeout(resetTimer.current)
    resetTimer.current = null
  }, [])

  const setMouseToDash = useCallback(
    (id?: string) => {
      if (!id) {
        mouseY.set(Infinity)
        return
      }

      const node = dashRefs.current.get(id)
      if (!node) return

      const rect = node.getBoundingClientRect()
      mouseY.set(rect.top + rect.height / 2)
    },
    [mouseY]
  )

  const pulseDash = useCallback(
    (id?: string) => {
      setMouseToDash(id)
      clearPendingReset()

      if (!id || pointerInside.current) return

      resetTimer.current = window.setTimeout(() => {
        mouseY.set(Infinity)
        resetTimer.current = null
      }, SCROLL_IDLE_RESET_DELAY)
    },
    [clearPendingReset, mouseY, setMouseToDash]
  )

  const selectSection = useCallback(
    (id: string) => {
      onSelectRef.current?.(id)
      activeIdRef.current = id
      setActiveId(id)
      pulseDash(id)

      if (selectFrame.current) window.cancelAnimationFrame(selectFrame.current)
      selectFrame.current = window.requestAnimationFrame(() => {
        selectFrame.current = null
        const element = getSectionElement(id)
        if (!element) return
        element.scrollIntoView({
          behavior: shouldReduceMotion ? "auto" : "smooth",
          block: "start",
        })
        window.history.replaceState(null, "", `#${id}`)
      })
    },
    [pulseDash, shouldReduceMotion]
  )

  useEffect(() => () => {
    clearPendingReset()
    if (selectFrame.current) window.cancelAnimationFrame(selectFrame.current)
  }, [clearPendingReset])

  const detectedKinds = useMemo(() => visibleSections.reduce<Record<string, SectionKind>>(
      (nextKinds, section) => {
        nextKinds[section.id] =
          section.kind || section.level
            ? getSectionKind(section)
            : getElementSectionKind(section.id) ?? getSectionKind(section)

        return nextKinds
      },
      {}
    ), [visibleSections])

  useEffect(() => {
    let frame = 0
    const scrollParents = new Set<EventTarget>([window])
    const sections = sectionsRef.current

    const updateActiveSection = () => {
      frame = 0

      const anchorY = window.innerHeight * activeOffset
      const entries: { element: HTMLElement; id: string }[] = []
      for (const section of sections) {
        const element = getSectionElement(section.id)
        if (element) entries.push({ element, id: section.id })
      }
      if (!entries.length) return

      // 区块按文档顺序排列，所以“离锚点最近”只可能是两个候选：最后一个顶边在
      // 锚点之上的区块，和它后面那个。以前每个区块都 getBoundingClientRect，
      // 长会话里一次滚动要强制几百次布局；二分只需要 ~8 次。
      let low = 0
      let high = entries.length - 1
      let above = -1
      while (low <= high) {
        const mid = (low + high) >> 1
        if (entries[mid].element.getBoundingClientRect().top <= anchorY) {
          above = mid
          low = mid + 1
        } else {
          high = mid - 1
        }
      }

      const candidates = above < 0 ? [0] : above + 1 < entries.length ? [above, above + 1] : [above]
      let nextActiveId = entries[0]?.id
      let shortestDistance = Number.POSITIVE_INFINITY
      for (const index of candidates) {
        const rect = entries[index].element.getBoundingClientRect()
        const containsAnchor = rect.top <= anchorY && rect.bottom >= anchorY
        const distance = containsAnchor
          ? 0
          : Math.min(Math.abs(rect.top - anchorY), Math.abs(rect.bottom - anchorY))
        if (distance < shortestDistance) {
          shortestDistance = distance
          nextActiveId = entries[index].id
        }
      }

      // 流式输出时自动贴底每帧都会触发 scroll；激活项没变就什么都不做，
      // 否则每帧都会让所有 dash 重新测量并重启弹簧动画。
      if (nextActiveId === activeIdRef.current) return
      activeIdRef.current = nextActiveId
      setActiveId(nextActiveId)

      if (!pointerInside.current) {
        pulseDash(nextActiveId)
      }
    }

    const scheduleUpdate = () => {
      if (frame) return
      frame = window.requestAnimationFrame(updateActiveSection)
    }

    // 所有 dash 都在同一个滚动容器里：只从第一个 section 往上找一次，
    // 以前对每个 section 都走一遍祖先链并逐个 getComputedStyle，长会话里
    // 每次目录更新要强制几千次样式计算。
    const first = sections.length ? getSectionElement(sections[0].id) : null
    if (first) scrollParents.add(getScrollParent(first))

    if (sections.length) {
      updateActiveSection()
    }
    const unsubscribe = sections.length ? subscribeToScroll(scrollParents, scheduleUpdate) : () => undefined

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      clearPendingReset()
      unsubscribe()
    }
  }, [activeOffset, clearPendingReset, pulseDash, sectionIds])

  return (
    <nav
      aria-label="Page sections"
      className={`flex h-full min-h-0 items-center ${
        side === "left" ? "justify-start" : "justify-end"
      } ${className}`}
    >
      <div
        className={`new-home_minimap__dDggR flex flex-col ${
          side === "right" ? "items-end" : "items-start"
        }`}
        style={{ gap: visibleSections.length > 64 ? 3 : visibleSections.length > 40 ? 4 : 6 }}
        onPointerMove={(event) => {
          clearPendingReset()
          pointerInside.current = true
          mouseY.set(event.clientY)
        }}
        onPointerLeave={() => {
          pointerInside.current = false
          mouseY.set(Infinity)
        }}
      >
        {visibleSections.map((section) => (
          <Dash
            key={section.id}
            active={section.id === activeId}
            mouseY={mouseY}
            onSelect={selectSection}
            previewsReady={previewsReady}
            registerDash={registerDash}
            section={section}
            sectionKind={detectedKinds[section.id] ?? getSectionKind(section)}
            side={side}
          />
        ))}
      </div>
    </nav>
  )
})

export default ProximitySidebar
