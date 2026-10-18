import {describe,expect,test} from 'bun:test'
import {commandSourceLabel,getCommandVisual} from '../src/lib/command-visual'

describe('skill and command visuals',()=>{
 test('uses colored file icons for recognizable artifact skills',()=>{
  expect(getCommandVisual('pdf','skill').icon).toBe('vscode-icons:file-type-pdf2')
  expect(getCommandVisual('spreadsheets','skill').icon).toBe('vscode-icons:file-type-excel2')
 })
 test('uses semantic icons for translation and YouTube skills',()=>{
  expect(getCommandVisual('baoyu-translate','skill')).toEqual({icon:'internet',tone:'translate'})
  expect(getCommandVisual('baoyu-youtube-transcript','skill')).toEqual({icon:'play',tone:'youtube'})
 })
 test('falls back to the source icon and localized source label',()=>{
  expect(getCommandVisual('custom-workflow','skill')).toEqual({icon:'sparkles',tone:'skill'})
  expect(commandSourceLabel('extension')).toBe('扩展')
 })
})
