/** Writes src/guide.gen.ts from guide/: the guide as a module, served the same on Node and on Workers. Run after editing guide/. */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { guideFiles, guideModuleSource } from '../src/kit/index.js'

const files = guideFiles(fileURLToPath(new URL('../guide', import.meta.url)))
writeFileSync(new URL('../src/guide.gen.ts', import.meta.url), guideModuleSource(files))
console.log(`Wrote ${files.size} guide files to src/guide.gen.ts`)
