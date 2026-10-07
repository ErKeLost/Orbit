import { modelMappings } from '@lobehub/icons'

/** Kept out of the boot path: this pulls the whole @lobehub/icons catalog. */
const familyLabels:Record<string,string>={'Z.ai':'GLM',ChatGLM:'GLM','GLM-V':'GLM',MoonshotAI:'Kimi',Anthropic:'Claude'}
const familyCache=new Map<string,string>()

export function modelFamily(id:string){
 const cached=familyCache.get(id);if(cached)return cached
 const normalized=id.toLowerCase()
 const match=modelMappings.find(item=>item.keywords.some(keyword=>normalized.search(keyword.toLowerCase())>=0))
 const raw=(match?.Icon as {title?:string}|undefined)?.title
 const family=raw?familyLabels[raw]??raw:'其他'
 familyCache.set(id,family);return family
}

