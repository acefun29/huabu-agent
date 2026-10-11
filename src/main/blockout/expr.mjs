/**
 * MVP 表达式求值器 —— blockout 参数层的 L0/L1 支撑
 *
 * 设计约束（来自 docs/blockout-param-design.md §3.2）：
 *  - 白名单极小：$ref、+ - * / ( )、min/max/clamp/lerp/round/floor/ceil/abs/sqrt
 *  - **不提供 pow/sin/cos/exp/log**：这些在不同 JS 引擎/版本上不保证逐位一致，
 *    会破坏「同输入 → 同输出」的确定性契约。需要平方写 x*x。
 *  - 禁止属性访问、函数定义、条件、宿主求值（不用 eval / new Function）
 *  - 编译期就解析出 refs 并检测未知名字：validate 阶段即可报错，不留到解算时
 */

const FUNCS = {
  min: (a, b) => Math.min(a, b),
  max: (a, b) => Math.max(a, b),
  abs: (a) => Math.abs(a),
  floor: (a) => Math.floor(a),
  ceil: (a) => Math.ceil(a),
  sqrt: (a) => Math.sqrt(a),
  round: (a, n = 0) => {
    const p = 10 ** n
    return Math.round(a * p) / p
  },
  clamp: (x, a, b) => Math.min(Math.max(x, a), b),
  lerp: (a, b, t) => a + (b - a) * t
}

export class ExprError extends Error {}

const TOKEN = /\s*(\$\w+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+|[A-Za-z_]\w*|[-+*/%(),])/y

function tokenize(src) {
  const out = []
  TOKEN.lastIndex = 0
  let pos = 0
  while (pos < src.length) {
    TOKEN.lastIndex = pos
    const m = TOKEN.exec(src)
    if (!m || m.index !== pos) {
      const rest = src.slice(pos, pos + 16)
      if (!rest.trim()) break
      throw new ExprError(`表达式无法解析（位置 ${pos}）："${rest}"`)
    }
    out.push(m[1])
    pos = TOKEN.lastIndex
  }
  return out
}

/** 递归下降：expr → term → unary → primary */
function parse(tokens, src) {
  let i = 0
  const peek = () => tokens[i]
  const eat = (t) => {
    if (tokens[i] !== t) throw new ExprError(`表达式 "${src}" 期望 "${t}"，实际 "${tokens[i] ?? '结尾'}"`)
    i += 1
  }

  function primary() {
    const t = peek()
    if (t === undefined) throw new ExprError(`表达式 "${src}" 意外结束`)
    if (t === '(') {
      eat('(')
      const e = expr()
      eat(')')
      return e
    }
    if (/^\$/.test(t)) {
      i += 1
      return { t: 'ref', name: t.slice(1) }
    }
    if (/^[A-Za-z_]/.test(t)) {
      i += 1
      eat('(')
      const args = []
      if (peek() !== ')') {
        args.push(expr())
        while (peek() === ',') {
          eat(',')
          args.push(expr())
        }
      }
      eat(')')
      if (!FUNCS[t]) throw new ExprError(`表达式 "${src}" 使用了不允许的函数 ${t}()`)
      return { t: 'call', name: t, args }
    }
    if (/^[\d.]/.test(t)) {
      i += 1
      return { t: 'num', v: Number(t) }
    }
    throw new ExprError(`表达式 "${src}" 出现意外记号 "${t}"`)
  }

  function unary() {
    if (peek() === '-') {
      i += 1
      return { t: 'neg', x: unary() }
    }
    if (peek() === '+') {
      i += 1
      return unary()
    }
    return primary()
  }

  function term() {
    let left = unary()
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = peek()
      i += 1
      left = { t: 'bin', op, l: left, r: unary() }
    }
    return left
  }

  function expr() {
    let left = term()
    while (peek() === '+' || peek() === '-') {
      const op = peek()
      i += 1
      left = { t: 'bin', op, l: left, r: term() }
    }
    return left
  }

  const ast = expr()
  if (i !== tokens.length) throw new ExprError(`表达式 "${src}" 有多余内容："${tokens.slice(i).join(' ')}"`)
  return ast
}

function collectRefs(ast, out = new Set()) {
  if (!ast || typeof ast !== 'object') return out
  if (ast.t === 'ref') out.add(ast.name)
  if (ast.t === 'bin') {
    collectRefs(ast.l, out)
    collectRefs(ast.r, out)
  }
  if (ast.t === 'neg') collectRefs(ast.x, out)
  if (ast.t === 'call') for (const a of ast.args) collectRefs(a, out)
  return out
}

function evalAst(ast, scope) {
  switch (ast.t) {
    case 'num':
      return ast.v
    case 'ref': {
      const v = scope[ast.name]
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new ExprError(`引用了未定义或非数字的参数 $${ast.name}`)
      return v
    }
    case 'neg':
      return -evalAst(ast.x, scope)
    case 'bin': {
      const a = evalAst(ast.l, scope)
      const b = evalAst(ast.r, scope)
      switch (ast.op) {
        case '+': return a + b
        case '-': return a - b
        case '*': return a * b
        case '/':
          if (Math.abs(b) < 1e-12) throw new ExprError('表达式出现除零')
          return a / b
        case '%':
          if (Math.abs(b) < 1e-12) throw new ExprError('表达式出现取模零')
          return a % b
      }
      break
    }
    case 'call': {
      const args = ast.args.map((a) => evalAst(a, scope))
      const fn = FUNCS[ast.name]
      if (ast.name === 'min' || ast.name === 'max') {
        if (args.length < 2) throw new ExprError(`${ast.name}() 至少 2 个参数`)
        return fn(...args)
      }
      return fn(...args)
    }
  }
  throw new ExprError('表达式节点非法')
}

/**
 * 编译一个字段值：数字直接返回；字符串（可含 $ref 与算式）编译为求值器。
 * 返回 { src, kind:'num'|'expr', refs:[], value(scope), raw }
 */
export function compileField(raw, where) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new ExprError(`${where}: 数字非法`)
    return { kind: 'num', src: String(raw), refs: [], value: () => raw, raw }
  }
  if (typeof raw !== 'string') throw new ExprError(`${where}: 需要数字或表达式字符串，得到 ${JSON.stringify(raw)}`)
  const ast = parse(tokenize(raw), raw)
  const refs = [...collectRefs(ast)]
  return {
    kind: 'expr',
    src: raw,
    refs,
    raw,
    value: (scope) => {
      const v = evalAst(ast, scope)
      if (!Number.isFinite(v)) throw new ExprError(`${where}: 表达式 "${raw}" 求值结果非有限数`)
      return v
    }
  }
}

/** 多元表达式字段（尺寸/偏移）：n 缺省为 3，plane 用 2 */
export function compileVec3(raw, where, n = 3) {
  if (raw === undefined) return null
  if (!Array.isArray(raw) || raw.length !== n) throw new ExprError(`${where}: 需要 ${n} 元数组`)
  const items = raw.map((v, i) => compileField(v, `${where}[${i}]`))
  return {
    src: raw,
    refs: [...new Set(items.flatMap((it) => it.refs))],
    value: (scope) => items.map((it) => it.value(scope))
  }
}

export const EXPR_FUNCS = Object.keys(FUNCS)
