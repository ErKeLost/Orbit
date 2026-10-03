import { existsSync, rmSync } from 'node:fs'
import { resolve, delimiter } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
const root=resolve(import.meta.dirname,'..')
const local=resolve(root,'work/toolchain')
const env={...process.env}
const args=process.argv.slice(2)
// Another project's Vite (or a second checkout) can already hold the default dev
// port. ORBIT_DEV_PORT moves both the Vite server and Tauri's devUrl together.
if(args[0]==='dev'&&env.ORBIT_DEV_PORT){
  args.push('--config',JSON.stringify({build:{devUrl:`http://localhost:${env.ORBIT_DEV_PORT}`}}))
}
const androidIndex=args.indexOf('android')
const androidAction=androidIndex<0?undefined:args[androidIndex+1]
if(androidIndex>=0&&['build','dev'].includes(androidAction)&&!args.includes('--target'))args.push('--target','aarch64')
const syncAndroidIcons=()=>spawnSync(process.execPath,[resolve(root,'scripts/sync-android-icons.mjs')],{cwd:root,env,stdio:'inherit'})
if(androidIndex>=0&&syncAndroidIcons().status!==0)process.exit(1)
// Build commands already run build.beforeBuildCommand, which bundles Pi.
// Keep the explicit preparation for dev/info commands that do not run it.
const isBuild=args[0]==='build'||(androidIndex>=0&&androidAction==='build')
if(!isBuild){
  const bundle=spawnSync(process.execPath,[resolve(root,'scripts/bundle-pi.mjs')],{cwd:root,env,stdio:'inherit'})
  if(bundle.status!==0)process.exit(bundle.status??1)
}
if(androidIndex<0&&['dev','build'].includes(args[0])){
  const profile=args[0]==='dev'?'debug':'release'
  for(const name of ['computer-use','node_modules','node-runtime','pi-computer-use','pi-runtime'])rmSync(resolve(root,'src-tauri/target',profile,'resources',name),{recursive:true,force:true})
  rmSync(resolve(root,'src-tauri/target',profile,'bundle'),{recursive:true,force:true})
}
// Keep macOS signing ad-hoc: self-signing the large Orbit executable can hang
// securityd on CI runners, while ad-hoc signing is immediate and deterministic.
if(process.platform==='darwin'&&androidIndex<0&&args[0]==='build'&&!env.APPLE_SIGNING_IDENTITY&&!env.APPLE_CERTIFICATE){
  env.APPLE_SIGNING_IDENTITY='-'
  console.log('[tauri] macOS app uses fast ad-hoc signing')
}
if(existsSync(resolve(local,'cargo/bin/rustup'))){
  env.RUSTUP_HOME=resolve(local,'rustup')
  env.CARGO_HOME=resolve(local,'cargo')
  env.PATH=resolve(local,'cargo/bin')+delimiter+(env.PATH??'')
}
const child=spawn(resolve(root,'node_modules/.bin/tauri'),args,{cwd:root,env,stdio:'inherit'})
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal))
child.on('exit',code=>{
  if(code===0&&androidAction==='init'&&syncAndroidIcons().status!==0){process.exitCode=1;return}
  process.exitCode=code??1
})
child.on('error',error=>{console.error(error.message);process.exitCode=1})
