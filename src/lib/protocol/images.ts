import type { ToolImage, ToolImageInfo } from './types'

const MAX_TOOL_RESULT_CHARS = 20_000
const boundedToolText = (text:string) => text.length <= MAX_TOOL_RESULT_CHARS ? text : `${text.slice(0,MAX_TOOL_RESULT_CHARS)}\n\n[输出过长，已省略]`
export function toolResultText(value:unknown):string {
  if(value == null)return ''
  if(typeof value==='string')return boundedToolText(value)
  if(typeof value==='number'||typeof value==='boolean')return String(value)
  if(Array.isArray(value))return boundedToolText(value.flatMap(item=>{
    if(typeof item==='string')return [item]
    if(item&&typeof item==='object'&&'text' in item&&typeof item.text==='string')return [item.text]
    if(item&&typeof item==='object'&&'type' in item&&item.type==='image')return ['[图片]']
    return []
  }).join('\n'))
  if(typeof value==='object'){
    const record=value as Record<string,unknown>
    if('content' in record)return toolResultText(record.content)
    for(const key of ['message','error','output','result'] as const){
      if(key in record){const text=toolResultText(record[key]);if(text)return text}
    }
  }
  return '工具执行完成'
}
/** Tool that generates images; its results carry media plus the model that ran. */
export const IMAGE_TOOL_NAME = 'generate_image'
export function toolResultImages(value:unknown):ToolImage[] {
  const images:ToolImage[] = []
  const visit=(input:unknown)=>{
    if(Array.isArray(input)){for(const item of input)visit(item);return}
    if(!input||typeof input!=='object')return
    const record=input as Record<string,unknown>
    const hasBytes = (typeof record.data==='string'&&record.data)||(typeof record.file==='string'&&record.file)||(typeof record.session==='string'&&typeof record.at==='number')
    if(record.type==='image'&&hasBytes&&typeof record.mimeType==='string'&&record.mimeType){
      images.push({...((typeof record.data==='string')?{data:record.data}:{}),...((typeof record.file==='string')?{file:record.file}:{}),...((typeof record.session==='string'&&typeof record.at==='number')?{session:record.session,at:record.at,ordinal:typeof record.ordinal==='number'?record.ordinal:0}:{}),mimeType:record.mimeType})
      return
    }
    if('content' in record)visit(record.content)
  }
  visit(value)
  return images
}
/** The model, pixel size, and local files a tool result reports, so the image
 * card can name it, reveal it in the file manager, and reuse it as a reference. */
export function toolImageInfo(toolName:string,source:unknown):ToolImageInfo|undefined {
  if(toolName!==IMAGE_TOOL_NAME)return undefined
  const details=(source as {details?:unknown}|null)?.details
  if(!details||typeof details!=='object')return undefined
  const record=details as Record<string,unknown>
  const model=typeof record.model==='string'?record.model:undefined
  const size=typeof record.size==='string'?record.size:undefined
  const paths=Array.isArray(record.paths)?record.paths.filter((path):path is string=>typeof path==='string'&&path.length>0):[]
  if(!model&&!paths.length)return undefined
  return {...(model?{model}:{}),...(size?{size}:{}),...(paths.length?{paths}:{})}
}
