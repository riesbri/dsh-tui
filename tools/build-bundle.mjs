/**
 * Transpile the bundle's sources to JavaScript without typechecking them.
 *
 * The bundle's types come from the harness, and the harness cannot supply them
 * from the registry: a published harness package depends on one that is not
 * published. Requiring a source checkout of a 200-package monorepo just to
 * install a plugin is unreasonable, so building and typechecking are separated —
 * `pnpm build` transpiles and works anywhere, `pnpm typecheck` resolves the real
 * service types and needs the harness beside this repo.
 *
 * TypeScript's own transpiler does this with no extra dependency and no native
 * binary: it erases types per file, resolves nothing, and rewrites the `.ts`
 * specifiers in relative imports to `.js` for the emitted output.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'tui')
const srcRoot = join(packageRoot, 'src')
const outRoot = join(packageRoot, 'lib')

/** Every `.ts` file under `dir`, recursively, as absolute paths. */
async function sources(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await sources(path))
    else if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

/** TypeScript's first semantic diagnostic code; everything below it is grammar. */
const SEMANTIC_DIAGNOSTIC_FLOOR = 2000

const options = {
  target: ts.ScriptTarget.ES2023,
  // ESNext, not NodeNext: transpileModule has no host to read the package `type`
  // from, so NodeNext resolves to CommonJS and the harness is ESM-only.
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  verbatimModuleSyntax: true,
  allowImportingTsExtensions: true,
  rewriteRelativeImportExtensions: true,
  removeComments: false,
}

let count = 0
for (const file of await sources(srcRoot)) {
  const source = await readFile(file, 'utf8')
  const { outputText, diagnostics } = ts.transpileModule(source, {
    compilerOptions: options,
    fileName: file,
    reportDiagnostics: true,
  })
  // Only grammar breaks the build. transpileModule also reports unresolved
  // modules (TS2307 and friends) because it still checks module augmentations,
  // and those are expected here: the harness types are deliberately absent, and
  // `pnpm typecheck` is what resolves them. TypeScript numbers syntactic
  // diagnostics below 2000 and semantic ones above it.
  const syntactic = (diagnostics ?? []).filter(diagnostic => diagnostic.code < SEMANTIC_DIAGNOSTIC_FLOOR)
  for (const diagnostic of syntactic) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    process.stderr.write(`${relative(packageRoot, file)}: ${message}\n`)
  }
  if (syntactic.length > 0) process.exitCode = 1
  const target = join(outRoot, relative(srcRoot, file)).replace(/\.ts$/u, '.js')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, outputText)
  count += 1
}

process.stdout.write(`transpiled ${String(count)} files to ${relative(packageRoot, outRoot)}/\n`)
