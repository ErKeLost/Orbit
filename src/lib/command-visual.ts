export type CommandVisual={icon:string;tone:string}

const rules:{terms:string[];icon:string;tone:string}[]=[
 {terms:['youtube'],icon:'play',tone:'youtube'},
 {terms:['translate','translation','localize'],icon:'internet',tone:'translate'},
 {terms:['find-skill','search'],icon:'search',tone:'search'},
 {terms:['spreadsheet','excel','sheet'],icon:'vscode-icons:file-type-excel2',tone:'native'},
 {terms:['slide','presentation','powerpoint','ppt'],icon:'vscode-icons:file-type-powerpoint2',tone:'native'},
 {terms:['document','docx','word'],icon:'vscode-icons:file-type-word2',tone:'native'},
 {terms:['pdf'],icon:'vscode-icons:file-type-pdf2',tone:'native'},
 {terms:['markdown','article','url-to-markdown'],icon:'vscode-icons:file-type-markdown',tone:'native'},
 {terms:['image','imagine','illustrator','comic','cover','infographic','xhs'],icon:'vscode-icons:file-type-image',tone:'native'},
 {terms:['video','sora'],icon:'vscode-icons:file-type-video',tone:'native'},
 {terms:['audio','transcript'],icon:'vscode-icons:file-type-audio',tone:'native'},
 {terms:['github'],icon:'git-branch',tone:'native'},
 {terms:['frontend','design','redesign','figma'],icon:'palette',tone:'design'},
 {terms:['browser','web'],icon:'globe',tone:'web'},
 {terms:['diagram','chart','visualize'],icon:'dashboard-square',tone:'data'},
 {terms:['code','diff','plugin','skill-creator','mastra','gsap','transition','game'],icon:'vscode-icons:file-type-typescript',tone:'native'},
]

export function getCommandVisual(name:string,source:string):CommandVisual{
 const key=name.toLowerCase()
 const match=rules.find(rule=>rule.terms.some(term=>key.includes(term)))
 if(match)return {icon:match.icon,tone:match.tone}
 if(source==='extension')return {icon:'sparkles',tone:'extension'}
 if(source==='skill')return {icon:'sparkles',tone:'skill'}
 return {icon:'list-bullet',tone:'prompt'}
}

export function commandSourceLabel(source:string):string{
 if(source==='skill')return '技能'
 if(source==='extension')return '扩展'
 if(source==='prompt')return '提示模板'
 return source
}
