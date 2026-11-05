import {useEffect,useState} from 'react'

/**
 * 窗口是否在前台。`document.hidden` 只覆盖最小化/切桌面这类真隐藏，够用了：
 * 我们要的是「看不见的时候别再画」，而不是精确的遮挡检测。
 */
export function usePageVisible(){
 const [visible,setVisible]=useState(()=>!document.hidden)
 useEffect(()=>{const update=()=>setVisible(!document.hidden);document.addEventListener('visibilitychange',update);return()=>document.removeEventListener('visibilitychange',update)},[])
 return visible
}

/**
 * 把可见性写到 `<html data-page-visible>`，让 CSS 有机会停掉无限循环动画
 * （`styles/orbit.css` 里的 `html[data-page-visible="false"] *`）。
 *
 * 这条规则一直存在，但从来没有人写过这个属性：切到后台以后 shimmer、转圈、
 * 像素小人照样按合成器的帧率重绘。一个属性、一次监听，就能让它们在后台停住。
 * 在挂载任何界面之前调用。
 */
export function installPageVisibility(){
 const root=document.documentElement
 const write=()=>{root.dataset.pageVisible=document.hidden?'false':'true'}
 write()
 document.addEventListener('visibilitychange',write)
 return ()=>document.removeEventListener('visibilitychange',write)
}
