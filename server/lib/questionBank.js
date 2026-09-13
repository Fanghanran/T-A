import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { childLogger } from './logger.js'

const log = childLogger('questionBank')

/**
 * questionBank —— 结构化面试题库（JSON 持久化 + 关键词 + 分类加权检索）
 *
 * 数据模型（每题）：
 * {
 *   id, title, category, tags: [], difficulty, company: [], source, answer, analysis
 * }
 *
 * 检索：
 * - 关键词 TF 匹配（title 权重×3，tags×2，answer×1）
 * - 技术栈/分类命中额外加分
 * - 支持按难度、公司、标签精确过滤
 * - 分数归一化到 0~1 区间，方便前端"Score"徽章展示
 *
 * 持久化：server/data/interview/questions.json（原子写 + debounce 300ms）
 * 首次启动目录/文件不存在 → 自动写入空题库 `{seq:0, questions:[]}`（纯靠后续上传/接口添加）
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '..', 'data', 'interview')
const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json')

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}

function writeJsonAtomic(file, data) {
  ensureDir()
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 0), 'utf8')
  fs.renameSync(tmp, file)
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback
    const raw = fs.readFileSync(file, 'utf8')
    return raw.trim() ? JSON.parse(raw) : fallback
  } catch (err) {
    log.warn(
      `[questionBank] 读取题库失败，将使用空题库：${err.message}`,
    )
    try { fs.renameSync(file, `${file}.corrupt.${Date.now()}`) } catch { /* ignore */ }
    return fallback
  }
}

// =====================================================================
// 种子题库（首次启动自动落盘，覆盖 React/JS/TS/Vue/Node/AI 大模型）
// 后续想扩充直接编辑 questions.json 或调 addQuestion/addQuestions API
// =====================================================================
const SEED_QUESTIONS = [
  // —— React 性能优化（源自 sample-notes.md）——
  {
    id: 'q_001', title: 'React 默认什么情况下会重新渲染子组件？如何避免不必要的渲染？',
    category: 'React', tags: ['性能优化', 'memo', '渲染'], difficulty: '简单', company: ['字节'],
    source: 'sample-notes.md',
    answer:
      'React 默认行为是「父组件渲染，则所有子组件也会重新渲染」，哪怕子组件的 props 完全没变。' +
      '避免方式：① React.memo 包裹函数组件，对 props 做浅比较，相等时跳过渲染；' +
      '② useMemo 缓存昂贵计算值；③ useCallback 缓存回调引用，避免传给子组件的 prop 每次都是新函数；' +
      '④ 将频繁更新的状态就近下沉，避免顶层 state 抖动触发整棵树重渲染。',
    analysis: '考点：React 渲染机制、memo/useMemo/useCallback 的使用场景与浅比较陷阱。',
  },
  {
    id: 'q_002', title: 'useMemo 和 useCallback 有什么区别？分别在什么场景用？',
    category: 'React', tags: ['Hooks', '性能优化'], difficulty: '简单', company: ['阿里', '腾讯'],
    source: 'sample-notes.md',
    answer:
      '两者底层都是 React 做缓存，只是缓存对象不同：\n' +
      '- useMemo(fn, deps) 缓存 **fn 的返回值**（计算结果、组件实例、派生状态等）；\n' +
      '- useCallback(fn, deps) 等价于 useMemo(() => fn, deps)，缓存 **函数引用本身**。\n\n' +
      '典型场景：useMemo 用于"算一次很贵"的派生数据；useCallback 用于把函数传给 React.memo 包裹的子组件，避免子组件因 prop 引用变更而重渲染。',
    analysis: '常见误区：在不需要的地方"滥用 memo 全家桶"反而增加运行时开销，memo 的浅比较本身也是成本。',
  },
  {
    id: 'q_003', title: 'React.memo 的浅比较具体比较什么？什么情况下浅比较会"误判相等"？',
    category: 'React', tags: ['memo', '性能优化'], difficulty: '中等', company: ['美团'],
    source: 'sample-notes.md',
    answer:
      'React.memo 默认对 props 做 === 比较：\n' +
      '- 原始类型（number/string/bool/null/undefined）比较值；\n' +
      '- 引用类型（object/array/function）比较内存地址。\n\n' +
      '典型"误判不相等"：父组件每次渲染都内联新建 {}、[]、()=>{}，此时 memo 会认为每次 props 都变，完全没拦住重渲染。' +
      '解决方案：对象/数组用 useMemo 包一层、函数用 useCallback 包一层；或自定义第二个参数 `areEqual(prevProps, nextProps)` 做深比较（但深比较本身也贵，要慎用）。',
    analysis: '结合代码手写 areEqual 是加分项。',
  },
  {
    id: 'q_004', title: '长列表性能如何优化？说一下 react-window 的原理。',
    category: 'React', tags: ['性能优化', '虚拟列表'], difficulty: '中等', company: ['滴滴'],
    source: 'sample-notes.md',
    answer:
      '核心手段是**虚拟列表（Windowing）**，常用库 react-window 或更强大的 react-virtualized。\n\n' +
      '原理：\n' +
      '- 给列表容器一个"总高度/总宽度"的占位；\n' +
      '- 根据当前 scrollTop / scrollLeft 计算"可视区间"内需要展示的行/列索引；\n' +
      '- 只把可视区域的节点渲染进真实 DOM，其余完全不创建（或最多留一个 buffer 区间防滚动时白屏）；\n' +
      '- 每个真实行通过 transform / top 绝对定位摆到对应位置。\n\n' +
      '收益：把 DOM 节点数从"万级"降到"几十级"，滚动流畅度大幅提升。',
    analysis: '延伸考点：动态高度如何处理？答案：预估高度 + 渲染后测量 + 重新分布偏移。',
  },
  {
    id: 'q_005', title: '为什么频繁更新的全局 Context 会导致整棵子树重渲染？如何拆分优化？',
    category: 'React', tags: ['性能优化', 'Context', '状态管理'], difficulty: '中等', company: ['京东'],
    source: 'sample-notes.md',
    answer:
      'Provider 接收到新的 value 引用时，所有消费这个 Context 的后代组件（useContext / Consumer）都会被强制更新，即便它们使用到的那部分数据没变。\n\n' +
      '优化手段：\n' +
      '① **Context 拆分**：把更新频率不同的状态放在不同 Context 里（比如 UI 主题低频、表单输入高频）；\n' +
      '② **选择器模式**：用 useContextSelector / Zustand/Jotai 这类支持按需订阅"部分 state"的库，避免不必要更新；\n' +
      '③ **状态下沉**：把只在局部子树用的高频状态从顶层 Context 移出，就近放在父组件 state。',
    analysis: '能说清"Context 更新链路"和"哪些组件会被纳入更新范围"就加分。',
  },
  {
    id: 'q_006', title: 'React 常见"白屏/卡顿"的排查思路（至少 4 条）。',
    category: 'React', tags: ['性能优化', '排查'], difficulty: '困难', company: ['字节', '拼多多'],
    source: 'sample-notes.md',
    answer:
      '常见思路（由浅入深）：\n' +
      '1) Performance 面板录制：看主线程长任务，定位是重渲染、JS 计算还是样式/重排。\n' +
      '2) React DevTools Profiler：看组件 commit 频率与耗时，锁定"不该渲染却渲染"的组件。\n' +
      '3) 虚拟列表/大表：长列表、大数据表格是否上了 Windowing？\n' +
      '4) 计算/解析：JSON.parse 大对象、正则回溯、深比较等热点，优先 useMemo 或 Web Worker 化。\n' +
      '5) Context/状态：高频状态是否"炸了一大片 Consumer"？拆分或换 Zustand 等细粒度订阅。\n' +
      '6) 图片/资源：大图片懒加载、CDN、骨架屏。\n' +
      '7) 副作用：useEffect/定时器累积、订阅忘记清理（Leak 排查）。',
    analysis: '能结合具体工具 + 工具截图讲清楚才算熟练，而不是只背术语。',
  },

  // —— JavaScript / 浏览器基础 ——
  {
    id: 'q_007', title: ' == 和 === 有什么区别？什么情况下建议用 == ？',
    category: 'JavaScript', tags: ['类型', '基础'], difficulty: '简单', company: ['腾讯'],
    source: '内置',
    answer:
      '- ===：严格相等，**既比较类型又比较值**，类型不同直接 false，不做隐式转换。\n' +
      '-  ==：宽松相等，类型不同时会先做**隐式类型转换**（比如把 string 转 number、把对象转原始值），再比较值。\n\n' +
      '建议 99% 场景用 ===，唯一例外是 `x == null`：这是同时判断 `null` 和 `undefined` 的惯用缩写，可读性好且不会出其他意外。',
    analysis: '经典题，回答时要主动提 "x == null" 这个唯一推荐用法是加分项。',
  },
  {
    id: 'q_008', title: 'Promise.all / Promise.allSettled / Promise.race / Promise.any 的区别？',
    category: 'JavaScript', tags: ['异步', 'Promise'], difficulty: '中等', company: ['美团', '网易'],
    source: '内置',
    answer:
      '四种并发组合器的语义：\n' +
      '1) **Promise.all**：全赢才赢，任何一个 reject 立即整体 reject；成功结果按输入顺序返回数组。\n' +
      '2) **Promise.allSettled**：永远等所有任务结束（不管成功/失败），结果是 {status, value/reason} 数组，不会整体抛错。\n' +
      '3) **Promise.race**：竞速，谁第一个 settled（无论成功失败）就以谁为结果。\n' +
      '4) **Promise.any**：只看成功，**有任意一个成功就返回成功结果**；全部都失败才抛 AggregateError。\n\n' +
      '选型口诀：要求全部成功用 all；不能容忍丢失败结果用 allSettled；超时竞争用 race；容错"只求一个能成"用 any。',
    analysis: '手写一个 Promise.all 或 allSettled 是高频考察点。',
  },
  {
    id: 'q_009', title: '什么是事件循环（Event Loop）？宏任务和微任务的执行顺序？',
    category: '浏览器', tags: ['事件循环', '异步'], difficulty: '中等', company: ['字节', '阿里', '腾讯'],
    source: '内置',
    answer:
      '事件循环是 JS 引擎实现"单线程异步"的调度机制：主线程同步执行完调用栈后，不断地轮询任务队列取任务来跑。\n\n' +
      '顺序（一个 tick）：\n' +
      '① 同步代码（调用栈）执行完毕 → 清空。\n' +
      '② 按**入队顺序**把当前所有 **微任务**（Promise.then/catch/finally、queueMicrotask、MutationObserver、await 后续）全部跑完，期间新入队的微任务也必须在本 tick 内跑完。\n' +
      '③ 再执行 **一条宏任务**（setTimeout/setInterval、I/O、UI rendering、requestAnimationFrame、setImmediate 等）。\n' +
      '④ 回到②：新宏任务里产生的微任务必须又一次全部清完，再轮到下一条宏任务。\n\n' +
      '口诀：**同步 → 微任务全清 → 1 条宏任务 → 微任务全清 → 1 条宏任务…**。',
    analysis: '给一段含 setTimeout + Promise + await + console.log 的代码，写出输出顺序是必考题。',
  },
  {
    id: 'q_010', title: '闭包是什么？常见应用场景 + 踩坑点？',
    category: 'JavaScript', tags: ['闭包', '作用域'], difficulty: '中等', company: ['拼多多', '京东'],
    source: '内置',
    answer:
      '闭包：一个函数能"记住并访问它被定义时的词法作用域"，即便该函数是在作用域之外被调用。实现上是引擎把函数引用 + 其外层环境（自由变量的绑定）打包保存。\n\n' +
      '常见场景：\n' +
      '① 工厂函数 / 柯里化；② 防抖节流；③ 私有变量（模块化）；④ 事件处理器与定时器里引用外层变量；⑤ React useEffect 依赖闭包捕获问题。\n\n' +
      '经典坑：循环里 var + setTimeout，所有回调共享同一个 i，输出全是循环结束后的值（ES6 用 let 块级作用域解决；或 IIFE 包一层）。',
    analysis: '能结合 React Hooks 里的"闭包陷阱"（useEffect 依赖遗漏/陈旧值）来谈，级别立刻上去。',
  },

  // —— TypeScript / 工程化 ——
  {
    id: 'q_011', title: 'interface 和 type 有什么异同？什么时候用哪个？',
    category: 'TypeScript', tags: ['类型系统', '基础'], difficulty: '简单', company: ['滴滴', '美团'],
    source: '内置',
    answer:
      '相同：都能描述对象形状、函数签名、支持联合/交叉。\n\n' +
      '差异：\n' +
      '① interface 支持**声明合并**（同名 interface 会被 TS 自动合并），type 不能重复声明。\n' +
      '② type 表达式能力更强：能写类型别名（给联合/交叉取名字）、条件类型 T extends U ? X : Y、映射类型 { [K in keyof T]: ... }、元组 [string, number] 等，这些 interface 做不到或很绕。\n' +
      '③ interface 只能描述对象/函数/类，type 什么都能描述（原始类型、联合、映射等）。\n\n' +
      '选型：\n' +
      '- 对外暴露给别人扩展的 API 形状、对象契约 → 优先 interface（方便别人声明合并）；\n' +
      '- 内部数据结构、联合/映射/条件类型等 → 用 type。',
    analysis: '能举出具体例子（如声明合并扩展 window）是加分项。',
  },
  {
    id: 'q_012', title: 'keyof、typeof、in 有什么用？写一个 Partial<T> 的简化实现。',
    category: 'TypeScript', tags: ['类型体操', '映射类型'], difficulty: '中等', company: ['字节', '蚂蚁'],
    source: '内置',
    answer:
      '- **keyof T**：取对象类型 T 的所有 key 组成的联合字面量（string literal union）。\n' +
      '- **typeof x**：取 JS 值 x 的 TS 类型，常和 as const 搭配把数组/对象当"类型源"。\n' +
      '- **in**：在映射类型 { [K in ...]: ... } 里遍历联合类型的每个成员。\n\n' +
      '简化版 Partial<T>（把 T 的每一项变为可选）：\n' +
      '```ts\ntype MyPartial<T> = { [K in keyof T]?: T[K] }\n```\n' +
      '同理可派生出 Required（把 ? 去掉）、Readonly（加 readonly）、Pick 等。',
    analysis: '手写 Omit/DeepReadonly/Return 参数等属于常规"类型体操"，至少要能手写 Pick、Omit。',
  },

  // —— 网络 / HTTP ——
  {
    id: 'q_013', title: 'HTTP 强缓存与协商缓存分别是什么？Cache-Control / ETag / Last-Modified 怎么配合？',
    category: '网络', tags: ['HTTP', '缓存'], difficulty: '中等', company: ['阿里', '腾讯'],
    source: '内置',
    answer:
      '目的：减少不必要的请求，提升首屏。\n\n' +
      '① **强缓存**（200 from disk/memory cache，不发请求）\n' +
      '  - `Cache-Control: max-age=3600`：秒级存活时间；`public` 可被 CDN 缓存，`private` 只能浏览器存；`no-store` 完全不缓存，`no-cache` 需先协商。\n' +
      '  - 只要资源没过期，浏览器直接用本地副本，根本不会发 HTTP 请求。\n\n' +
      '② **协商缓存**（发请求 → 服务器判断 304 Not Modified / 200 新内容）\n' +
      '  - 基于指纹：服务器响应头给 `ETag: "abc123"`（内容哈希），下次请求头带 `If-None-Match: "abc123"`，服务器比对一致 → 304。\n' +
      '  - 基于时间：`Last-Modified: <GMT>`，下次请求头 `If-Modified-Since`，服务器判断是否更新过。\n  - ETag 优先级高于 Last-Modified（时间只能到秒且文件改回原值会误判）。\n\n' +
      '配合：命中强缓存直接用；过期才走协商；协商一致 304 复用本地缓存、不一致返回 200 新内容 + 更新 ETag/时间。',
    analysis: '结合项目中 Webpack/Vite 产出的带 hash 静态资源谈"hash 化文件长期 Cache-Control: immutable"是加分项。',
  },
  {
    id: 'q_014', title: '跨域是什么？CORS 预检请求（OPTIONS）是什么场景触发的？',
    category: '网络', tags: ['跨域', 'CORS'], difficulty: '中等', company: ['美团', '京东'],
    source: '内置',
    answer:
      '跨域：浏览器同源策略（协议/域名/端口任一不同）下，脚本默认读不到其他源返回的响应（注意：请求本身是能发出去的，浏览器会拦截响应）。\n\n' +
      '简单请求不触发预检：方法只能 GET/HEAD/POST；Content-Type 仅 application/x-www-form-urlencoded / multipart/form-data / text/plain；不能有自定义请求头。\n\n' +
      '满足以下任一条就会**先发 OPTIONS 预检**：\n' +
      '① 方法为 PUT/DELETE/PATCH 等非简单方法；\n' +
      '② Content-Type 是 application/json 等非上述三种；\n' +
      '③ 请求头包含了自定义字段（比如 Authorization、X-Token、自定义业务头）；\n' +
      '④ 设置了 `withCredentials: true` 且服务端允许携带 cookie。\n\n' +
      '服务器响应 OPTIONS 时需返回 `Access-Control-Allow-Origin / Allow-Methods / Allow-Headers / Max-Age` 等头，浏览器确认允许后才真正发实际请求。',
    analysis: '实际排查：OPTIONS 返回 401/404 多半是后端中间件没放行；把鉴权逻辑放在跨域中间件之前就会被 OPTIONS 拦住。',
  },

  // —— 算法 / 数据结构 ——
  {
    id: 'q_015', title: '手写深拷贝（考虑循环引用、Symbol、Set/Map）。',
    category: '算法', tags: ['手写代码', '数据结构'], difficulty: '困难', company: ['字节', '百度'],
    source: '内置',
    answer:
      '思路：递归 + 缓存（WeakMap 记录已拷贝过的引用，防循环引用爆栈）。\n\n' +
      '简化实现：\n' +
      '```js\nfunction deepClone(obj, cache = new WeakMap()) {\n  if (obj === null || typeof obj !== "object") return obj;\n  if (cache.has(obj)) return cache.get(obj);\n  const Ctor = obj.constructor;\n  if ([Date, RegExp, Map, Set].includes(Ctor)) return new Ctor(obj);\n  const clone = Array.isArray(obj) ? [] : Object.create(Object.getPrototypeOf(obj));\n  cache.set(obj, clone);\n  // 普通 key + Symbol key\n  for (const k of [...Object.keys(obj), ...Object.getOwnPropertySymbols(obj)]) {\n    clone[k] = deepClone(obj[k], cache);\n  }\n  return clone;\n}\n```\n' +
      'Map/Set 也可以逐个 set 进去做深拷贝；JSON.parse(JSON.stringify(x)) 丢失函数/undefined/Symbol/循环引用，只是简单场景够用。',
    analysis: '回答"structuredClone 原生支持"更现代，但面试希望手写。',
  },
  {
    id: 'q_016', title: '手写防抖 debounce 与节流 throttle，并说出区别。',
    category: '算法', tags: ['手写代码', '高频'], difficulty: '中等', company: ['滴滴', '网易'],
    source: '内置',
    answer:
      '区别：\n' +
      '- 防抖（debounce）：连续触发 → 等"停下来 N 毫秒不再触发"再执行一次；高频输入中只跑最后一次。\n' +
      '- 节流（throttle）：连续触发 → 保证"N 毫秒内最多执行一次"；高频输入下按固定节拍均匀执行。\n\n' +
      '简化版 debounce（带立即执行选项）：\n' +
      '```js\nfunction debounce(fn, wait, immediate = false) {\n  let timer = null, invoked = false;\n  return function (...args) {\n    const ctx = this;\n    if (timer) clearTimeout(timer);\n    if (immediate && !invoked) { fn.apply(ctx, args); invoked = true; }\n    timer = setTimeout(() => {\n      if (!immediate) fn.apply(ctx, args);\n      timer = null; invoked = false;\n    }, wait);\n  };\n}\n```\n' +
      'throttle 常用"时间戳 + 定时器"双保险（第一次立即、最后一次也确保触发）。',
    analysis: '搜索框联想用 debounce；滚动/拖拽监听用 throttle；按钮防重复提交两个都行。',
  },

  // —— Node.js ——
  {
    id: 'q_017', title: '浏览器 JS 和 Node.js 的事件循环有什么不同？',
    category: 'Node.js', tags: ['事件循环', '异步'], difficulty: '困难', company: ['蚂蚁', '阿里云'],
    source: '内置',
    answer:
      '核心差异：两者模型不一样。\n\n' +
      '浏览器（单事件循环 + 宏/微两级）：一条宏任务 → 清空全部微任务 → 下一条宏任务。\n\n' +
      'Node.js（libuv 的 6 个阶段轮询，每个阶段内执行完该阶段宏任务后，清空当前阶段微任务）：\n' +
      '顺序：timer（setTimeout/setInterval 到期回调）→ pending callbacks → idle/prepare → poll（I/O 回调，最核心最耗时）→ check（setImmediate）→ close callbacks。\n\n' +
      '且 Node 有两个特殊点：\n' +
      '① **process.nextTick**：比 Promise.then 微任务还要先跑，"插在当前阶段与下一阶段之间"。\n' +
      '② setTimeout(fn, 0) vs setImmediate：timer 阶段前有一个最小 ms(>=1ms) 的门槛，两者谁先触发在裸事件循环里不确定；放在 I/O 回调里 setImmediate 一定先于 setTimeout，因为 I/O 后紧跟 check 阶段。\n\n' +
      '口诀：浏览器"一宏一清微"，Node"每个阶段跑完宏任务再清微任务"，微任务内部还分 nextTick 优先。',
    analysis: 'Node 11 之后 Node 也向浏览器靠拢了（执行完每个宏任务就清空微任务），但仍保留阶段语义 + nextTick，所以讲清楚"阶段 + nextTick + setImmediate"就过关。',
  },
  {
    id: 'q_018', title: 'Node.js 中间件模式是什么？说一下 Koa 洋葱模型。',
    category: 'Node.js', tags: ['中间件', 'Koa'], difficulty: '中等', company: ['携程', 'B站'],
    source: '内置',
    answer:
      '中间件：把请求处理逻辑拆成一串可插拔的小函数，依次（或按条件）执行，每个函数只关心一件事（鉴权/日志/压缩/路由…）。\n\n' +
      'Express 是"线性队列"：每个中间件 next() 后调用下一个，响应返回时是线性回溯。\n' +
      'Koa 是**洋葱模型**：请求从外向内依次穿过每个中间件（await next() 之前的代码），到最内层路由后，响应再从内向外依次返回（await next() 之后的代码）。\n\n' +
      '洋葱模型的好处：\n' +
      '- 可以在"后段"统一捕获内层错误（全局异常中间件）；\n' +
      '- 可以在"出口"统一打点耗时（next 前后 Date.now() 相减）；\n' +
      '- 逻辑按"前/后"集中在同一个函数里，可读性好。',
    analysis: '手写一个简化版 Koa compose（递归调用 dispatch(i)）是加分项。',
  },
]

// ========== 内存状态（per-owner 题库；'*' = admin 聚合视图） ==========
// 存储：data/interview/questions/<ownerId>.json（ownerId 仅允许字母数字_-，防路径穿越）
// 旧版全局 questions.json 首次加载时自动迁移为 questions/admin.json
const BANKS_DIR = path.join(DATA_DIR, 'questions')
const LEGACY_FILE = QUESTIONS_FILE
const OWNER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const banks = new Map() // ownerId → { questions, seq, saveTimer }

function assertOwner(ownerId) {
  if (!OWNER_ID_RE.test(String(ownerId))) {
    throw new Error(`questionBank: 非法 ownerId：${ownerId}`)
  }
  return ownerId
}

function bankFile(ownerId) {
  return path.join(BANKS_DIR, `${assertOwner(ownerId)}.json`)
}

function migrateLegacyFile() {
  try {
    if (!fs.existsSync(LEGACY_FILE)) return
    fs.mkdirSync(BANKS_DIR, { recursive: true })
    const adminFile = path.join(BANKS_DIR, 'admin.json')
    if (!fs.existsSync(adminFile)) {
      fs.renameSync(LEGACY_FILE, adminFile)
      log.info('[questionBank] 旧版全局题库已迁移 → questions/admin.json')
    } else {
      fs.renameSync(LEGACY_FILE, `${LEGACY_FILE}.migrated`)
      log.info('[questionBank] 旧版全局题库已存在迁移产物，改名保留为 questions.json.migrated')
    }
  } catch (err) {
    log.warn(`[questionBank] 旧题库迁移失败（${err.message}），忽略`)
  }
}

function readBankFile(ownerId) {
  const raw = readJsonSafe(bankFile(ownerId), null)
  if (raw && Array.isArray(raw.questions)) {
    return { questions: raw.questions, seq: Number(raw.seq) || raw.questions.length }
  }
  return null
}

function writeBank(ownerId, bank) {
  try {
    fs.mkdirSync(BANKS_DIR, { recursive: true })
    writeJsonAtomic(bankFile(ownerId), { seq: bank.seq, questions: bank.questions })
  } catch (err) {
    log.error(`[questionBank] 保存 ${ownerId} 题库失败：${err.message}`)
  }
}

const seedDisabled = (process.env.QUESTION_SEED ?? '').trim().toLowerCase() === 'off'

function bankOf(ownerId) {
  assertOwner(ownerId)
  let bank = banks.get(ownerId)
  if (bank) return bank
  const loaded = readBankFile(ownerId)
  if (loaded) {
    bank = loaded
  } else {
    // 新 owner：空题库 + 自动灌入种子题（QUESTION_SEED=off 时不灌）
    bank = { questions: [], seq: 0 }
    if (!seedDisabled && SEED_QUESTIONS.length > 0) {
      bank.questions = SEED_QUESTIONS.map((q) => ({ ...q }))
      bank.seq = bank.questions.length
    }
    writeBank(ownerId, bank)
    log.info(`[questionBank] 初始化 ${ownerId} 题库：${bank.questions.length} 题`)
  }
  banks.set(ownerId, bank)
  return bank
}

/** '*'（admin 聚合视图）：合并全部已落盘题库（只读；跨 owner id 可能重复，仅展示用） */
function mergedQuestions() {
  const out = []
  for (const f of fs.existsSync(BANKS_DIR) ? fs.readdirSync(BANKS_DIR) : []) {
    if (!f.endsWith('.json')) continue
    const raw = readJsonSafe(path.join(BANKS_DIR, f), null)
    if (raw && Array.isArray(raw.questions)) out.push(...raw.questions)
  }
  for (const bank of banks.values()) out.push(...bank.questions)
  return out
}

function scheduleSave(ownerId) {
  const bank = banks.get(ownerId)
  if (!bank) return
  if (bank.saveTimer) clearTimeout(bank.saveTimer)
  bank.saveTimer = setTimeout(() => {
    bank.saveTimer = null
    writeBank(ownerId, bank)
  }, 300)
}

function flushAllSync() {
  for (const [ownerId, bank] of banks) {
    if (bank.saveTimer) { clearTimeout(bank.saveTimer); bank.saveTimer = null }
    writeBank(ownerId, bank)
  }
}

/** 兼容旧调用（启动自检/健康检查聚合口径） */
export function load() {
  migrateLegacyFile()
  return stats('*')
}

// ========== 检索 ==========
const TOKEN_SPLIT = /[\s,，。、;；:：?？!！.。/\\|()（）\[\]【】《》"'`~@#$%^&*_+=\-<>{}]+/

function tokenize(text) {
  return [...new Set(
    String(text || '').toLowerCase().split(TOKEN_SPLIT).filter(Boolean),
  )]
}

/**
 * 结构化面试题检索（per-owner）
 * @param {string} q            用户关键词
 * @param {Object} opts
 * @param {string}  opts.ownerId 必填：用户 id；'*' = admin 聚合；非法/缺失 → 空结果（fail-closed）
 * @param {string[]} [opts.techStack] 与 TECH_STACK_OPTIONS 对齐，命中 category/tag 加分
 * @param {string}   [opts.difficulty] 简单/中等/困难
 * @param {string}   [opts.company]
 * @param {string}   [opts.tag]
 * @param {number}   [opts.limit]  默认 5
 * @returns {Array<{id, title, category, tags, difficulty, company, answer, analysis, source, score:number}>}
 */
export function search(q, opts = {}) {
  const { techStack = [], difficulty, company, tag, limit = 5 } = opts
  const ownerId = opts.ownerId
  if (ownerId !== '*' && !OWNER_ID_RE.test(String(ownerId))) return [] // fail-closed
  const qTokens = tokenize(q)

  // 先按精确过滤缩范围
  let pool = ownerId === '*' ? mergedQuestions() : bankOf(ownerId).questions
  if (difficulty) pool = pool.filter((x) => x.difficulty === difficulty)
  if (company)    pool = pool.filter((x) => x.company?.includes(company))
  if (tag)        pool = pool.filter((x) => x.tags?.includes(tag))

  const techStackNorm = new Set((techStack || []).map((t) => String(t).toLowerCase()))
  const titleText = q ? q.toLowerCase() : ''

  // 打分
  const scores = new Map()
  for (const it of pool) {
    let rawScore = 0
    if (qTokens.length) {
      const titleToks = tokenize(it.title)
      const answerToks = tokenize(it.answer)
      const tagSet = new Set((it.tags || []).map((t) => String(t).toLowerCase()))
      const catTok = String(it.category || '').toLowerCase()

      for (const tok of qTokens) {
        // 完整标题出现 -> 分数加成更高（支持中英文子串匹配）
        if (titleToks.includes(tok)) rawScore += 3
        if (tagSet.has(tok)) rawScore += 2
        if (catTok === tok) rawScore += 3
        if (answerToks.includes(tok)) rawScore += 1
        // 子串兜底：中英文短词可能 token 拆不出来
        if (it.title.toLowerCase().includes(titleText) && titleText.length >= 2) rawScore += 0.5
      }
    }

    // 技术栈匹配加分
    if (techStackNorm.size) {
      const cat = String(it.category || '').toLowerCase()
      if (techStackNorm.has(cat)) rawScore += 2
      for (const tg of it.tags || []) {
        if (techStackNorm.has(String(tg).toLowerCase())) { rawScore += 1; break }
      }
    }

    if (rawScore > 0 || !qTokens.length) scores.set(it.id, rawScore)
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
  const byId = new Map(pool.map((q) => [q.id, q]))

  // 归一化到 0~1（最大为 1）
  const maxRaw = sorted.length ? sorted[0][1] : 1
  return sorted.map(([id, raw], idx) => {
    const q = byId.get(id)
    const score = Number((maxRaw > 0 ? raw / maxRaw : 0).toFixed(4))
    return {
      rank: idx + 1,
      id: q.id,
      title: q.title,
      category: q.category,
      tags: q.tags,
      difficulty: q.difficulty,
      company: q.company,
      source: q.source,
      answer: q.answer,
      analysis: q.analysis,
      score,
    }
  })
}

// ========== 增删改查（interview 路由 / 管理端用，均 per-owner） ==========

/**
 * 列出题目。
 * @param {{category?:string, difficulty?:string, ownerId:string}} opts ownerId 必填；'*' = admin 聚合
 */
export function listQuestions({ category, difficulty, ownerId } = {}) {
  let items = ownerId === '*' ? mergedQuestions() : OWNER_ID_RE.test(String(ownerId)) ? [...bankOf(ownerId).questions] : []
  if (category) items = items.filter((q) => q.category === category)
  if (difficulty) items = items.filter((q) => q.difficulty === difficulty)
  return items
}

export function getQuestion(id, ownerId) {
  if (ownerId === '*') return mergedQuestions().find((q) => q.id === id) || null
  if (!OWNER_ID_RE.test(String(ownerId))) return null
  return bankOf(ownerId).questions.find((q) => q.id === id) || null
}

/** 新增题目（写入 ownerId 自己的题库；'*' 不允许写入） */
export function addQuestion(data, ownerId) {
  if (ownerId === '*' || !OWNER_ID_RE.test(String(ownerId))) {
    throw new Error('questionBank.addQuestion 需要具体 ownerId（不允许聚合视图写入）')
  }
  const bank = bankOf(ownerId)
  bank.seq += 1
  const q = {
    id: `q_${bank.seq}`,
    title: data.title,
    category: data.category || '',
    tags: data.tags || [],
    difficulty: data.difficulty || '中等',
    company: data.company || [],
    source: data.source || '手动',
    answer: data.answer || '',
    analysis: data.analysis || '',
  }
  bank.questions.push(q)
  scheduleSave(ownerId)
  return q
}

export function deleteQuestion(id, ownerId) {
  if (ownerId === '*' || !OWNER_ID_RE.test(String(ownerId))) return false
  const bank = bankOf(ownerId)
  const idx = bank.questions.findIndex((q) => q.id === id)
  if (idx >= 0) { bank.questions.splice(idx, 1); scheduleSave(ownerId); return true }
  return false
}

/** 统计（'*' = 全库聚合；健康检查自检用 '*'） */
export function stats(ownerId = '*') {
  const all = ownerId === '*' ? mergedQuestions() : OWNER_ID_RE.test(String(ownerId)) ? bankOf(ownerId).questions : []
  const byCategory = new Map()
  for (const q of all) {
    byCategory.set(q.category, (byCategory.get(q.category) || 0) + 1)
  }
  return {
    total: all.length,
    byCategory: [...byCategory.entries()].map(([name, count]) => ({ name, count })),
  }
}

// 启动迁移 + 退出兜底
migrateLegacyFile()
try {
  process.on('exit', flushAllSync)
  process.on('SIGINT',  () => { try { flushAllSync() } catch {}; process.exit(130) })
  process.on('SIGTERM', () => { try { flushAllSync() } catch {}; process.exit(143) })
} catch { /* 非 Node 环境忽略 */ }
