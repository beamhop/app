// The ES module transformer, tested by running what it produces through the real loader.
import { describe, expect, it } from 'vitest'
import { transformEsm } from '../src/esm/transform.js'
import { run, testMachine, write } from './helpers.js'

/** Write a module graph, run /work/main.mjs, return what it printed (or its stderr). */
async function runModules(files: Record<string, string>): Promise<string> {
  const m = testMachine()
  for (const [name, source] of Object.entries(files)) write(m, '/work/' + name, source)
  const r = await run(m, ['node', 'main.mjs'])
  return r.stderr ? 'STDERR ' + r.stderr : r.stdout.trimEnd()
}

describe('transformEsm output', () => {
  it('reports dependencies, literal dynamic imports and top-level await', () => {
    const r = transformEsm(`import a from './a.js'\nexport * from "./b.js"\nexport { x } from './a.js'\nconst lazy = () => import('./c.js'), computed = (n) => import(n)\n`)
    expect(r.deps).toEqual(['./a.js', './b.js'])
    expect(r.dynamicImports).toEqual(['./c.js'])
    expect(r.async).toBe(false)
    expect(r.code.startsWith('System.register(["./a.js","./b.js"], function ($__export, $__ctx) { "use strict";')).toBe(true)
    expect(transformEsm('await 1').async).toBe(true)
    expect(transformEsm('for await (const x of y) {}').async).toBe(true)
    expect(transformEsm('async function f() { await 1 }').async).toBe(false)
    // a function declaration as the very first statement (nothing to move it in front of)
    expect(transformEsm('function first() { return second() }\nfunction second() {}\nexport { first }').code).toMatch(/function second\(\) \{\}\n[^]*function first|function first[^]*function second/)
  })

  it('rewrites import() and import.meta in code only, never in strings, templates or comments', () => {
    const { code } = transformEsm('const s = "import(\'x\') import.meta.url" // import("y")\nconst t = `import("z") ${import.meta.url}`\nexport const f = () => import("real")\n')
    expect(code).toContain(`s = "import('x') import.meta.url"; // import("y")`)
    expect(code).toContain('`import("z") ${$__ctx.meta.url}`')
    expect(code).toContain('$__ctx.import("real")')
  })

  it('reports syntax errors with the file name and position', () => {
    expect(() => transformEsm('export const = 1', '/work/bad.mjs')).toThrow(/\(\/work\/bad\.mjs:1:14\)/)
    expect(() => transformEsm('export const = 1', '/work/bad.mjs')).toThrow(SyntaxError)
  })
})

describe('module semantics after transformation', () => {
  it('keeps exports live across modules, including reassignment, compound assignment and ++', async () => {
    expect(
      await runModules({
        'state.mjs': 'export let count = 0, label = "a"\nexport function bump() { const before = count++; count += 10; label = label + "b"; return before }\nexport function reset() { ({ count, label } = { count: 100, label: "z" }) }',
        'main.mjs': 'import { count, label, bump, reset } from "./state.mjs"\nimport * as ns from "./state.mjs"\nconst before = bump()\nconst mid = [count, label, ns.count]\nreset()\nconsole.log(before, mid.join(), count, label, ns.label)',
      }),
    ).toBe('0 11,ab,11 100 z z')
  })

  it('does not re-export through a shadowing binding', async () => {
    expect(
      await runModules({
        'm.mjs': `export let value = 1
export function viaParam(value) { value = 50; return value }
export function viaBlock() { { let value = 60; value++ } for (let value = 0; value < 3; value++) {} try { throw 1 } catch (value) { value = 70 } return value }
export function viaInner() { const f = function value() { return 1 }; class K { m(value) { value = 80 } } new K().m(); return f() }
export function real() { value = 2 }`,
        'main.mjs': 'import { value, viaParam, viaBlock, viaInner, real } from "./m.mjs"\nconst a = [viaParam(9), viaBlock(), viaInner(), value]\nreal()\nconsole.log(a.join(), value)',
      }),
    ).toBe('50,1,1,1 2')
  })

  it('handles minified code where statements touch (declarations, exports and imports with no whitespace between)', async () => {
    expect(
      await runModules({
        'min.mjs': 'import{a as A}from"./dep.mjs";var x=A+1;export let y=x*2;var z=3;export{z as zed,x};export const{p,q:[r]}={p:7,q:[8]};export default(x,y)\nclass K{}export{K};y=y+1;',
        'dep.mjs': 'export const a=1;',
        'main.mjs': 'import d, { x, y, zed, p, r, K } from "./min.mjs"\nconsole.log(d, x, y, zed, p, r, typeof K)',
      }),
    ).toBe('4 2 5 3 7 8 function')
  })

  it('hoists function declarations so a cycle can call them before the module body has run', async () => {
    expect(
      await runModules({
        'a.mjs': 'import { fromB } from "./b.mjs"\nexport function helper() { return "helper" }\nexport default function () { return "anon-default" }\nexport const ready = "a-ran:" + fromB',
        'b.mjs': 'import anon, { helper, ready } from "./a.mjs"\nexport const fromB = helper() + "+" + anon() + "+" + ready',
        'main.mjs': 'import { ready } from "./a.mjs"\nconsole.log(ready)',
      }),
    ).toBe('a-ran:helper+anon-default+undefined')
  })

  it('supports re-exports: named, renamed, star, and namespace', async () => {
    expect(
      await runModules({
        'base.mjs': 'export let n = 1\nexport const fixed = "f"\nexport default "base-default"\nexport function grow() { n++ }',
        'mid.mjs': 'export * from "./base.mjs"\nexport { fixed as renamed, default as baseDefault } from "./base.mjs"\nexport * as all from "./base.mjs"\nimport { n } from "./base.mjs"\nexport { n as viaImport }',
        'main.mjs': 'import * as mid from "./mid.mjs"\nmid.grow()\nconsole.log(Object.keys(mid).sort().join(), mid.n, mid.viaImport, mid.all.n, mid.renamed, mid.baseDefault, "default" in mid)',
      }),
    ).toBe('all,baseDefault,fixed,grow,n,renamed,viaImport 2 2 2 f base-default false')
  })

  it('treats var in nested blocks as module-level, visible to hoisted functions', async () => {
    expect(
      await runModules({
        'main.mjs': 'if (true) { var fromBlock = 1 }\nfor (var i = 0, j; i < 3; i++) {}\nfor (var key in { a: 1, b: 2 }) {}\ntry { var { d, e: [f] } = { d: 4, e: [5] } } catch {}\nfunction read() { return [fromBlock, i, j, key, d, f].join() }\nconsole.log(read())',
      }),
    ).toBe('1,3,,b,4,5')
  })

  it('awaits top-level await in dependency order and loads import() lazily', async () => {
    expect(
      await runModules({
        'slow.mjs': 'globalThis.order = ["slow:start"]\nawait new Promise((r) => setTimeout(r, 20))\norder.push("slow:end")\nexport const v = 1',
        'fast.mjs': 'order.push("fast")\nexport const w = 2',
        'lazy.mjs': 'order.push("lazy")\nexport default "L"',
        'main.mjs': 'import { v } from "./slow.mjs"\nimport { w } from "./fast.mjs"\norder.push("main")\nconst lazy = await import("./lazy.mjs")\nconsole.log(order.join(" "), v + w, lazy.default, this === undefined)\ndelete globalThis.order',
      }),
    ).toBe('slow:start slow:end fast main lazy 3 L true')
  })

  it('imports CommonJS, JSON and built-ins with default and named bindings', async () => {
    expect(
      await runModules({
        'c.cjs': 'exports.named = "n"; exports.other = 2',
        'j.json': '{"k": [1, 2]}',
        'main.mjs': '#!/usr/bin/env node\nimport c, { named } from "./c.cjs"\nimport j from "./j.json" with { type: "json" }\nimport EventEmitter, { once } from "node:events"\nimport { createRequire } from "node:module"\nconst require = createRequire(import.meta.url)\nconsole.log(c.other, named, j.k.length, typeof EventEmitter, typeof once, require("./c.cjs") === c)',
      }),
    ).toBe('2 n 2 function function true')
  })

  it('lets CommonJS require() an ES module, unless the graph uses top-level await', async () => {
    const m = testMachine()
    write(m, '/work/sync.mjs', 'export const a = 1\nexport default "d"')
    write(m, '/work/async.mjs', 'await 0\nexport const b = 2')
    write(m, '/work/main.cjs', 'const ns = require("./sync.mjs"); let code; try { require("./async.mjs") } catch (e) { code = e.code }\nconsole.log(ns.a, ns.default, code)')
    expect((await run(m, ['node', 'main.cjs'])).stdout).toBe('1 d ERR_REQUIRE_ASYNC_MODULE\n')
  })

  it('reports a syntax error in a module written at run time, and picks up the fixed file', async () => {
    const m = testMachine()
    write(m, '/work/main.mjs', 'export const = 1')
    const bad = await run(m, ['node', 'main.mjs'])
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('SyntaxError')
    expect(bad.stderr).toContain('/work/main.mjs:1:14')
    write(m, '/work/main.mjs', 'console.log("fixed")')
    expect((await run(m, ['node', 'main.mjs'])).stdout).toBe('fixed\n')
  })
})
