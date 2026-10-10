import {test,expect} from 'bun:test'
import {observe,emptyTelemetry} from '../src/lib/telemetry'
import {getChange,getToolCodePresentation,MAX_CODE_PREVIEW_CHARS} from '../src/lib/changes'
import {mergeProjects,normalizeProjectPath,projectExtraRoots,projectRoots,removeProject,replaceProject} from '../src/lib/projects'
import {mergeProjectSessions} from '../src/hooks/use-project-sessions'
test('compaction keeps actual status and estimates, never invents progress percentages',()=>{
 let state=observe(emptyTelemetry(),{type:'compaction_start',reason:'threshold'},1000)
 expect(state.compaction?.status).toBe('running')
 expect(state.compaction).not.toHaveProperty('percent')
 state=observe(state,{type:'compaction_end',reason:'threshold',result:{tokensBefore:96000,estimatedTokensAfter:23000,summary:'saved'},aborted:false,willRetry:true},6000)
 expect(state.compaction).toMatchObject({status:'complete',startedAt:1000,endedAt:6000,tokensBefore:96000,estimatedTokensAfter:23000,willRetry:true})
})
test('failed or cancelled compaction never displays a successful token reduction',()=>{
 const started=observe(emptyTelemetry(),{type:'compaction_start',reason:'manual'},0)
 const cancelled=observe(started,{type:'compaction_end',reason:'manual',result:null,aborted:true},3)
 const failed=observe(started,{type:'compaction_end',reason:'manual',result:null,errorMessage:'quota'},3)
 expect(cancelled.compaction?.status).toBe('cancelled');expect(failed.compaction?.status).toBe('error');expect(failed.compaction?.estimatedTokensAfter).toBeUndefined()
})
test('Pi full patch is preferred; write shows added contents without claiming an old-file snapshot',()=>{
 expect(getChange('edit',{path:'x.ts'},{details:{patch:'--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b',diff:'not a patch'}})?.kind).toBe('patch')
 expect(getChange('edit',{path:'x.ts'},{details:{diff:'+changed'}})).toBeNull()
 expect(getChange('write',{path:'x.ts',content:'new'},{})).toEqual({kind:'snippet',name:'x.ts',before:'',after:'new',label:'写入内容（全部新增）'})
 expect(getToolCodePresentation('write',{path:'x.ts',content:'new'},'done').result).toMatchObject({kind:'snippet',before:'',after:'new'})
})
test('read and bash use plain code; edit and patches use diffs without oversized payloads',()=>{
 expect(getToolCodePresentation('read',{path:'src/app.ts'},'const value = 1')).toMatchObject({result:{kind:'file',name:'src/app.ts',label:false}})
 expect(getToolCodePresentation('bash',{command:'cargo test'},'ok')).toEqual({request:{kind:'file',contents:'cargo test',name:'command.sh',label:'命令'},result:{kind:'file',contents:'ok',name:'terminal-output.log',label:'结果'}})
 const patch='--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new'
 expect(getToolCodePresentation('bash',{command:'git diff'},patch).result?.kind).toBe('patch')
 expect(getToolCodePresentation('edit',{path:'src/app.ts',edits:[{oldText:'old',newText:'new'}]},'done',{patch}).result?.kind).toBe('patch')
 expect(getToolCodePresentation('read',{path:'huge.ts'},'x'.repeat(MAX_CODE_PREVIEW_CHARS+1))).toEqual({})
})
test('multiple project directories deduplicate by path, not by display name',()=>{
 const projects=mergeProjects([] ,['/a/app/','/b/app','/a/app'])
 expect(projects).toEqual([{path:'/a/app',name:'app'},{path:'/b/app',name:'app'}])
})

test('project connection paths use one stable spelling',()=>{
 expect(normalizeProjectPath('/Users/work/pi-gui/')).toBe('/Users/work/pi-gui')
 expect(normalizeProjectPath('/')).toBe('/')
})
test('removing a project only removes the exact workspace path',()=>{
 const projects=mergeProjects([] ,['/a/app','/b/app'])
 expect(removeProject(projects,'/a/app')).toEqual([{path:'/b/app',name:'app'}])
})
test('a project keeps one primary directory and deduplicated app roots',()=>{
 const project={path:'/work/app/',name:'Workspace',roots:['/work/app','/work/api/','/work/api','/work/web']}
 expect(projectRoots(project)).toEqual(['/work/app','/work/api','/work/web'])
 expect(projectExtraRoots(project)).toEqual(['/work/api','/work/web'])
 expect(replaceProject([],project)).toEqual([{path:'/work/app',name:'Workspace',roots:['/work/app','/work/api','/work/web']}])
})
test('live sessions only appear under their owning project directory',()=>{
 const live=[
  {cwd:'/a/app',path:'/sessions/a.jsonl',title:'A task',running:true},
  {cwd:'/b/app',path:'/sessions/b.jsonl',title:'B task',running:false},
 ]
 expect(mergeProjectSessions('/a/app',[],live).sessions.map(session=>session.path)).toEqual(['/sessions/a.jsonl'])
 expect(mergeProjectSessions('/b/app',[],live).sessions.map(session=>session.path)).toEqual(['/sessions/b.jsonl'])
})
