import type { ForgeConfig } from '@electron-forge/shared-types'
import { MakerSquirrel } from '@electron-forge/maker-squirrel'
import { MakerZIP } from '@electron-forge/maker-zip'
import { VitePlugin } from '@electron-forge/plugin-vite'
const config:ForgeConfig={packagerConfig:{asar:true},makers:[new MakerSquirrel({}),new MakerZIP({},['win32'])],plugins:[new VitePlugin({build:[{entry:'src/main.ts',config:'vite.main.config.ts'},{entry:'src/preload.ts',config:'vite.preload.config.ts'}],renderer:[{name:'main_window',config:'vite.renderer.config.ts'}]})]};export default config
