import sharp from 'sharp'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { encodeIco } from './lib/ico.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const resources = join(root, 'resources')
const source = join(resources, 'icon.svg')
const render = size => sharp(source).resize(size, size).png().toBuffer()
await sharp(source).resize(1024, 1024).png().toFile(join(resources, 'icon.png'))
// Windows reads the executable, installer, taskbar and tray icons from one ICO; 256 px is the largest size Explorer requests.
await writeFile(join(resources, 'icon.ico'), encodeIco(await Promise.all([16, 24, 32, 48, 64, 128, 256].map(async size => ({ size, png: await render(size) })))))
if (process.platform === 'darwin') {
  const iconset = join(resources, 'icon.iconset')
  await mkdir(iconset, { recursive: true })
  for (const size of [16, 32, 128, 256, 512]) {
    await sharp(source).resize(size, size).png().toFile(join(iconset, `icon_${size}x${size}.png`))
    await sharp(source).resize(size * 2, size * 2).png().toFile(join(iconset, `icon_${size}x${size}@2x.png`))
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'icon.icns')])
  await rm(iconset, { recursive: true })
}
console.log('Faangin icons generated.')
