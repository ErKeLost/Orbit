import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { MicSelector } from "./mic-selector"
import { LiveWaveform } from "./live-waveform"

vi.mock("@/shared/ui/Popover", () => ({Popover:({children}:{children:React.ReactNode})=><div>{children}</div>}))
const enumerateDevices=vi.fn()
const getUserMedia=vi.fn()
let listeners: EventTarget
let root:Root,host:HTMLDivElement
beforeEach(()=>{
  vi.clearAllMocks();listeners=new EventTarget()
  enumerateDevices.mockResolvedValue([{kind:"audioinput",deviceId:"builtin",label:"Built-in microphone",groupId:"internal"},{kind:"audioinput",deviceId:"usb",label:"USB microphone",groupId:"external"}])
  Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{enumerateDevices,getUserMedia,addEventListener:listeners.addEventListener.bind(listeners),removeEventListener:listeners.removeEventListener.bind(listeners)}})
  vi.stubGlobal("AudioContext",vi.fn())
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue(null)
  host=document.createElement("div");document.body.append(host);root=createRoot(host)
})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals()})
async function render(node:React.ReactNode){await act(async()=>{root.render(node)})}

describe("voice controls project the owned microphone",()=>{
  test("device enumeration, rerenders and remounting never submit an implicit device change",async()=>{
    const change=vi.fn()
    await render(<MicSelector value="builtin" onValueChange={change} />)
    expect(host.textContent).toContain("Built-in microphone")
    await render(<MicSelector value="builtin" onValueChange={id=>change(id)} />)
    await render(<div/>);await render(<MicSelector value="builtin" onValueChange={change} />)
    expect(change).not.toHaveBeenCalled();expect(getUserMedia).not.toHaveBeenCalled()
    await act(async()=>listeners.dispatchEvent(new Event("devicechange")))
    expect(change).not.toHaveBeenCalled();expect(getUserMedia).not.toHaveBeenCalled()
  })
  test("only an explicit selection changes the controlled microphone",async()=>{
    const change=vi.fn();await render(<MicSelector value="builtin" onValueChange={change} />)
    await act(async()=>host.querySelector("button")!.click())
    const option=[...host.querySelectorAll("button")].find(button=>button.textContent?.trim()==="USB microphone")!
    await act(async()=>option.click())
    expect(change).toHaveBeenCalledExactlyOnceWith("usb")
    expect(getUserMedia).not.toHaveBeenCalled()
    await render(<MicSelector value="usb" onValueChange={change} />)
    expect(host.querySelector("button")!.textContent).toContain("USB microphone")
  })
  test("a waveform with supplied levels never creates another capture stream or audio context",async()=>{
    await render(<LiveWaveform active level={0.1} />)
    await render(<LiveWaveform active level={0.8} />)
    await render(<LiveWaveform active={false} processing level={0} />)
    await render(<LiveWaveform active level={0.3} />)
    expect(getUserMedia).not.toHaveBeenCalled();expect(AudioContext).not.toHaveBeenCalled()
  })
})
