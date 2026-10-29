import sharp from 'sharp'
import { mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const resources = join(root, 'resources')
const source = join(resources, 'icon.svg')
await sharp(source).resize(1024, 1024).png().toFile(join(resources, 'icon.png'))
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
