// ES module -> System.register form, the shape the Node layer's loader links and runs.
//
// A browser worker cannot evaluate ES module source from a string with a custom loader, so every ES module
// the machine runs is rewritten into a function. The image builder does this ahead of time for the files a
// harness is known to reach; the worker lazy-loads this same transformer for everything else (files written
// or installed at run time).
//
// Output:
//   System.register([deps], function ($__export, $__ctx) { "use strict";
//     var <imports and module-level bindings>; <function declarations>
//     return { setters: [...], execute: [async] function () { <module body> } } })
//
// What is preserved: live bindings in both directions (setters re-run when a dependency exports again; every
// assignment to an exported binding re-exports it, with scope analysis so shadowed names are left alone),
// hoisted function declarations (callable by importers in a cycle before this module has run), cycles,
// top-level await (execute becomes async), `import()` and `import.meta` (found in the syntax tree, never by
// text search), re-exports and `export *`.
// What is not: the temporal dead zone and `const` immutability of module-level bindings (they become `var`),
// and `for (exported of …)` loop heads do not re-export on each iteration.
import { type AnyNode, type Identifier, type Pattern, parse, type Program } from 'acorn'
import MagicString from 'magic-string'

export interface TransformResult {
  code: string
  /** Static dependencies in order of first appearance: the module's import and re-export specifiers. */
  deps: string[]
  /** String-literal `import('…')` specifiers, for the image builder's reachability trace. */
  dynamicImports: string[]
  /** True when the module uses top-level await. */
  async: boolean
}

type Binding = { dep: number; imported: string } // imported: 'default', '*' (namespace) or an export name

const q = (s: string): string => JSON.stringify(s)
/** Cannot occur in source text that parsed. */
const BODY_MARK = '\u0000body\u0000'
const isNode = (v: unknown): v is AnyNode => typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string'

/** Names bound by a declaration pattern, or assigned by an assignment target (member expressions bind nothing). */
function patternNames(node: Pattern | AnyNode | null | undefined, out: string[] = []): string[] {
  if (!node) return out
  switch (node.type) {
    case 'Identifier':
      out.push(node.name)
      break
    case 'ObjectPattern':
      for (const p of node.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out)
      break
    case 'ArrayPattern':
      for (const e of node.elements) patternNames(e, out)
      break
    case 'AssignmentPattern':
      patternNames(node.left, out)
      break
    case 'RestElement':
      patternNames(node.argument, out)
      break
  }
  return out
}

/** `var` names declared anywhere inside `node`, not descending into nested functions. */
function varNames(node: AnyNode, out: Set<string>): void {
  if (node.type === 'VariableDeclaration' && node.kind === 'var') for (const d of node.declarations) for (const n of patternNames(d.id)) out.add(n)
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') return
  for (const value of Object.values(node as unknown as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const v of value) if (isNode(v)) varNames(v, out)
    } else if (isNode(value)) varNames(value, out)
  }
}

/** Lexical names declared directly in a statement list. */
function lexicalNames(body: readonly AnyNode[], out: Set<string>): Set<string> {
  for (const s of body) {
    if (s.type === 'VariableDeclaration' && s.kind !== 'var') for (const d of s.declarations) for (const n of patternNames(d.id)) out.add(n)
    else if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) out.add(s.id.name)
  }
  return out
}

export function transformEsm(source: string, filename = '<module>'): TransformResult {
  let ast: Program
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowReturnOutsideFunction: true })
  } catch (e) {
    const err = e as Error & { loc?: { line: number; column: number } }
    throw Object.assign(new SyntaxError(`${err.message.replace(/ \(\d+:\d+\)$/, '')} (${filename}${err.loc ? `:${err.loc.line}:${err.loc.column + 1}` : ''})`), { code: 'ERR_ESM_TRANSFORM' })
  }
  // Insertion rule used throughout: text placed before a node is attached to the node (appendRight at its start),
  // text placed after it is attached to the node too (appendLeft at its end). Attached to a neighbour instead, it
  // would vanish when that neighbour is removed, which in minified code (`a=1;var b`) is the common case.
  const s = new MagicString(source)
  if (source.startsWith('#!')) s.remove(0, source.indexOf('\n') === -1 ? source.length : source.indexOf('\n'))

  const deps: string[] = []
  const depIndex = (spec: string): number => {
    const i = deps.indexOf(spec)
    return i === -1 ? deps.push(spec) - 1 : i
  }
  const imports = new Map<string, Binding>() // local name -> where it comes from
  const exportsOf = new Map<string, string[]>() // local name -> exported names
  const reexports: { dep: number; imported: string; exported: string }[] = [] // imported '*' = namespace
  const starExports: number[] = []
  const hoistedVars = new Set<string>()
  const functionNames = new Set<string>()
  const dynamicImports: string[] = []
  let usesAwait = false

  const addExport = (local: string, exported: string): void => {
    const list = exportsOf.get(local)
    if (list) list.push(exported)
    else exportsOf.set(local, [exported])
  }
  const nameOf = (n: Identifier | { type: 'Literal'; value?: unknown }): string => (n.type === 'Identifier' ? n.name : String(n.value))

  // ---- pass 1: collect imports and the export table (exports can refer to declarations further down) ----
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      const dep = depIndex(String(node.source.value))
      for (const sp of node.specifiers) {
        const imported = sp.type === 'ImportDefaultSpecifier' ? 'default' : sp.type === 'ImportNamespaceSpecifier' ? '*' : nameOf(sp.imported)
        imports.set(sp.local.name, { dep, imported })
        hoistedVars.add(sp.local.name)
      }
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.source) {
        const dep = depIndex(String(node.source.value))
        for (const sp of node.specifiers) reexports.push({ dep, imported: nameOf(sp.local), exported: nameOf(sp.exported) })
      } else if (node.declaration) {
        const d = node.declaration
        if (d.type === 'VariableDeclaration') for (const decl of d.declarations) for (const n of patternNames(decl.id)) addExport(n, n)
        else if (d.id) addExport(d.id.name, d.id.name)
      } else for (const sp of node.specifiers) addExport(nameOf(sp.local), nameOf(sp.exported))
    } else if (node.type === 'ExportDefaultDeclaration') {
      const d = node.declaration
      if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) addExport(d.id.name, 'default')
    } else if (node.type === 'ExportAllDeclaration') {
      const dep = depIndex(String(node.source.value))
      if (node.exported) reexports.push({ dep, imported: '*', exported: nameOf(node.exported) })
      else starExports.push(dep)
    }
  }
  /** `$__export("a", $__export("b", <value>))` for every name `local` is exported under. */
  const exportCalls = (local: string): string => (exportsOf.get(local) ?? []).map((name) => `$__export(${q(name)}, ${local});`).join('')
  const isLiveExport = (name: string): boolean => exportsOf.has(name) && !imports.has(name)

  // ---- pass 2: rewrite inside expressions (scope-aware), everywhere in the module ----
  const scopes: Set<string>[] = []
  const shadowed = (name: string): boolean => scopes.some((sc) => sc.has(name))
  let functionDepth = 0

  const walkChildren = (node: AnyNode): void => {
    for (const [key, value] of Object.entries(node as unknown as Record<string, unknown>)) {
      if (key === 'type') continue
      if (Array.isArray(value)) {
        for (const v of value) if (isNode(v)) walk(v, node)
      } else if (isNode(value)) walk(value, node)
    }
  }
  const withScope = (names: Set<string>, fn: () => void): void => {
    scopes.push(names)
    fn()
    scopes.pop()
  }
  const liveTargets = (target: AnyNode): string[] => patternNames(target).filter((n) => isLiveExport(n) && !shadowed(n))

  function walk(node: AnyNode, parent: AnyNode | null): void {
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        const names = new Set<string>()
        for (const p of node.params) for (const n of patternNames(p)) names.add(n)
        if (node.type === 'FunctionExpression' && node.id) names.add(node.id.name)
        if (node.type !== 'ArrowFunctionExpression') names.add('arguments')
        varNames(node.body, names)
        functionDepth++
        withScope(names, () => walkChildren(node))
        functionDepth--
        return
      }
      case 'BlockStatement':
      case 'StaticBlock':
        return withScope(lexicalNames(node.body, new Set()), () => walkChildren(node))
      case 'SwitchStatement': {
        walk(node.discriminant, node)
        const names = new Set<string>()
        for (const c of node.cases) lexicalNames(c.consequent, names)
        return withScope(names, () => node.cases.forEach((c) => walk(c, node)))
      }
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        if (node.type === 'ForOfStatement' && node.await && functionDepth === 0) usesAwait = true
        const head = node.type === 'ForStatement' ? node.init : node.left
        const names = new Set<string>()
        if (head && head.type === 'VariableDeclaration' && head.kind !== 'var') for (const d of head.declarations) for (const n of patternNames(d.id)) names.add(n)
        return withScope(names, () => walkChildren(node))
      }
      case 'CatchClause':
        return withScope(new Set(patternNames(node.param)), () => walkChildren(node))
      case 'ClassDeclaration':
      case 'ClassExpression':
        return withScope(new Set(node.id ? [node.id.name] : []), () => walkChildren(node))
      case 'AwaitExpression':
        if (functionDepth === 0) usesAwait = true
        break
      case 'MetaProperty':
        if (node.meta.name === 'import') s.overwrite(node.start, node.end, '$__ctx.meta')
        return
      case 'ImportExpression':
        s.overwrite(node.start, node.source.start, '$__ctx.import(')
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') dynamicImports.push(node.source.value)
        break
      case 'AssignmentExpression': {
        const targets = liveTargets(node.left)
        if (targets.length > 0) {
          if (node.left.type === 'Identifier' && (exportsOf.get(targets[0]) ?? []).length === 1) {
            s.appendRight(node.start, `$__export(${q(exportsOf.get(targets[0])![0])}, `)
            s.appendLeft(node.end, ')')
          } else {
            s.appendRight(node.start, `((v) => (${targets.map(exportCalls).join('').replace(/;/g, ',')} v))(`)
            s.appendLeft(node.end, ')')
          }
        }
        break
      }
      case 'UpdateExpression': {
        const targets = liveTargets(node.argument)
        if (targets.length > 0) {
          s.appendRight(node.start, `((v) => (${targets.map(exportCalls).join('').replace(/;/g, ',')} v))(`)
          s.appendLeft(node.end, ')')
        }
        break
      }
      case 'VariableDeclaration':
        if (node.kind === 'await using' && functionDepth === 0) usesAwait = true
        // A `var` nested in a block at module level is still a module-level binding: hoist it like the top-level ones.
        if (node.kind === 'var' && functionDepth === 0 && parent && parent.type !== 'Program' && parent.type !== 'ExportNamedDeclaration') rewriteDeclaration(node, parent)
        break
    }
    walkChildren(node)
  }

  /** Turn `var|let|const a = 1, {b} = c, d` into assignments to hoisted variables: `a = 1, void ({b} = c), void 0`. */
  function rewriteDeclaration(node: Extract<AnyNode, { type: 'VariableDeclaration' }>, parent: AnyNode | null): void {
    const first = node.declarations[0]
    const loopHead = parent !== null && (parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') && parent.left === node
    s.remove(node.start, first.start)
    for (const d of node.declarations) {
      for (const n of patternNames(d.id)) hoistedVars.add(n)
      if (loopHead) continue // `for (var x of xs)` -> `for (x of xs)`; a pattern is a valid target as it stands
      if (!d.init) s.overwrite(d.start, d.end, 'void 0')
      else if (d.id.type !== 'Identifier') {
        // `void (` rather than a bare `(`: a statement starting with a parenthesis could continue the previous line.
        s.appendRight(d.start, 'void (')
        s.appendLeft(d.end, ')')
      }
    }
  }

  for (const node of ast.body) walk(node, ast)

  // ---- pass 3: module-level declarations, imports and exports ----
  // Function declarations are moved, edits and all, to the front of the text; BODY_MARK then separates them from
  // the module body so the two parts can be placed in different scopes. (Moving is constant-time per function;
  // slicing each one out is quadratic in a module with thousands of them.)
  const hoist = (start: number, end: number): void => {
    s.appendLeft(end, '\n')
    s.move(start, end, 0)
  }
  let anonymousDefault = 0
  for (const node of ast.body) {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
        s.remove(node.start, node.end)
        break
      case 'VariableDeclaration':
        if (node.kind === 'using' || node.kind === 'await using') break
        rewriteDeclaration(node, ast)
        s.appendLeft(node.end, ';' + node.declarations.flatMap((d) => patternNames(d.id)).map(exportCalls).join(''))
        break
      case 'FunctionDeclaration':
        functionNames.add(node.id.name)
        hoist(node.start, node.end)
        break
      case 'ClassDeclaration':
        hoistedVars.add(node.id.name)
        s.appendRight(node.start, `${node.id.name} = `)
        s.appendLeft(node.end, ';' + exportCalls(node.id.name))
        break
      case 'ExportNamedDeclaration': {
        const d = node.declaration
        if (!d) {
          s.remove(node.start, node.end)
        } else if (d.type === 'FunctionDeclaration') {
          functionNames.add(d.id.name)
          s.remove(node.start, d.start)
          hoist(d.start, d.end)
        } else if (d.type === 'ClassDeclaration') {
          hoistedVars.add(d.id.name)
          s.overwrite(node.start, d.start, `${d.id.name} = `)
          s.appendLeft(d.end, ';' + exportCalls(d.id.name))
        } else {
          s.remove(node.start, d.start)
          if (d.kind !== 'using' && d.kind !== 'await using') rewriteDeclaration(d, node)
          s.appendLeft(d.end, ';' + d.declarations.flatMap((x) => patternNames(x.id)).map(exportCalls).join(''))
        }
        break
      }
      case 'ExportDefaultDeclaration': {
        const d = node.declaration
        if (d.type === 'FunctionDeclaration') {
          let name = d.id?.name
          if (!name) {
            name = `$__default${anonymousDefault++ || ''}`
            s.appendLeft(d.start + /^(async\s+)?function(\s*\*)?/.exec(source.slice(d.start))![0].length, ' ' + name)
            addExport(name, 'default')
          }
          functionNames.add(name)
          s.remove(node.start, d.start)
          if (node.end > d.end) s.remove(d.end, node.end)
          hoist(d.start, d.end)
        } else if (d.type === 'ClassDeclaration' && d.id) {
          hoistedVars.add(d.id.name)
          s.overwrite(node.start, d.start, `${d.id.name} = `)
          s.appendLeft(d.end, ';' + exportCalls(d.id.name))
        } else {
          // An expression, or an anonymous class. Keep any parentheses: only the two keywords are replaced.
          const keywords = /^export\s+default\s*/.exec(source.slice(node.start))![0].length
          s.overwrite(node.start, node.start + keywords, '$__export("default", ')
          s.appendLeft(source[node.end - 1] === ';' ? node.end - 1 : node.end, ')')
        }
        break
      }
    }
  }

  // ---- assemble ----
  const setters = deps.map((_, dep) => {
    let body = ''
    for (const [local, b] of imports) {
      if (b.dep !== dep) continue
      body += `${local} = ${b.imported === '*' ? 'm' : `m[${q(b.imported)}]`};${exportCalls(local)}`
    }
    for (const r of reexports) if (r.dep === dep) body += `$__export(${q(r.exported)}, ${r.imported === '*' ? 'm' : `m[${q(r.imported)}]`});`
    if (starExports.includes(dep)) body += 'var e = {}; for (var k in m) if (k !== "default" && k !== "__esModule") e[k] = m[k]; $__export(e);'
    return `function (m) {${body}}`
  })
  // Every export name exists from link time on (namespace objects are enumerated before the module runs);
  // function declarations carry their value already, everything else starts undefined.
  const early: string[] = []
  for (const [local, names] of exportsOf) {
    if (imports.has(local)) continue
    for (const name of names) early.push(`${q(name)}: ${functionNames.has(local) ? local : 'void 0'}`)
  }
  for (const name of functionNames) hoistedVars.delete(name)
  s.prependRight(0, BODY_MARK)
  const [functions, body] = s.toString().split(BODY_MARK)
  const header =
    `System.register(${JSON.stringify(deps)}, function ($__export, $__ctx) { "use strict";` +
    (hoistedVars.size ? ` var ${[...hoistedVars].join(', ')};` : '') +
    (functionNames.size ? '\n' + functions : '') +
    (early.length ? ` $__export({${early.join(', ')}});` : '') +
    ` return { setters: [${setters.join(', ')}], execute: ${usesAwait ? 'async ' : ''}function () {\n`
  return { code: header + body + '\n} }; });', deps, dynamicImports, async: usesAwait }
}

/** Changes whenever the transformer's code does; the image builder keys its on-disk transform cache with it. */
export const TRANSFORM_FINGERPRINT: string = [transformEsm, patternNames, varNames, lexicalNames].map(String).join('\n')
