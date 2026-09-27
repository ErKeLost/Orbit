import { existsSync, rmSync } from 'node:fs'
import { resolve, delimiter } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
const root=resolve(import.meta.dirname,'..')
const local=resolve(root,'work/toolchain')
const env={...process.env}
const args=process.argv.slice(2)
const androidIndex=args.indexOf('android')
const androidAction=androidIndex<0?undefined:args[androidIndex+1]
if(androidIndex>=0&&['build','dev'].includes(androidAction)&&!args.includes('--target'))args.push('--target','aarch64')
const syncAndroidIcons=()=>spawnSync(process.execPath,[resolve(root,'scripts/sync-android-icons.mjs')],{cwd:root,env,stdio:'inherit'})
if(androidIndex>=0&&syncAndroidIcons().status!==0)process.exit(1)
const bundle=spawnSync(process.execPath,[resolve(root,'scripts/bundle-pi.mjs')],{cwd:root,env,stdio:'inherit'})
if(bundle.status!==0)process.exit(bundle.status??1)
if(androidIndex<0&&['dev','build'].includes(args[0])){
  const profile=args[0]==='dev'?'debug':'release'
  for(const name of ['computer-use','node_modules','node-runtime','pi-computer-use','pi-runtime'])rmSync(resolve(root,'src-tauri/target',profile,'resources',name),{recursive:true,force:true})
  rmSync(resolve(root,'src-tauri/target',profile,'bundle'),{recursive:true,force:true})
}
// macOS 桌面构建用固定的自签证书签名（scripts/make-signing-cert.sh 生成），
// 让 Designated Requirement 稳定：应用内更新覆盖 .app 后辅助功能授权不再丢失。
// APPLE_SIGNING_IDENTITY 优先级高于 tauri.conf.json 的 signingIdentity（tauri-cli 行为）。
const MACOS_SIGNING_IDENTITY='Orbit Developer'
if(process.platform==='darwin'&&androidIndex<0&&args[0]==='build'&&!env.APPLE_SIGNING_IDENTITY&&!env.APPLE_CERTIFICATE){
  const found=spawnSync('security',['find-identity','-p','codesigning'],{encoding:'utf8'})
  if((found.stdout||'').includes(`"${MACOS_SIGNING_IDENTITY}"`)){
    env.APPLE_SIGNING_IDENTITY=MACOS_SIGNING_IDENTITY
    console.log(`[tauri] macOS 构建签名身份："${MACOS_SIGNING_IDENTITY}"（应用内更新保留辅助功能授权）`)
  }else{
    console.warn(`[tauri] 未找到自签证书 "${MACOS_SIGNING_IDENTITY}"，本次构建回退 ad-hoc 签名：升级后辅助功能授权会丢失。运行 bun run signing:setup 生成。`)
  }
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
