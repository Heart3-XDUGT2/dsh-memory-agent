/**
 * dsh-echo — 数据文件的**结构真源**(纯结构,零值)
 * ============================================================
 * 设计依据:`Desktop\交接\数据程序分离设计-2026-10-05.md` §3(阶段 B / P0)。
 *
 * 这个文件只回答三件事:
 *   ① 每个数据文件长什么样 —— 字段清单(key / type / 必填 / 上限 / 范围);
 *   ② 空模板是什么 —— 真空值('' / [] / {} / null),**绝不是任何真人值**;
 *   ③ 一个对象算不算合法 —— `validateFile()` / `checkSchemaRev()`。
 *
 * 纪律(与 P0 任务书逐条对应):
 *   - **不放真人值**:称呼 / 人名 / 校名 / 别名一个都不许出现在这个文件里;
 *   - **不放程序默认值**:阈值 / 权重 / 初值的真源是 `lib/toggle.js` 的
 *     `SETTINGS_DEFAULTS` 与各算法模块;这里只写"空",写不出"默认值";
 *   - **不放钳位规则**:钳位仍在 `lib/toggle.js` 的 `normalizeSettings()` 一处;
 *   - 与 `lib/settings-fields.js` 的分工:那张表管**调参面板**(config.json 的
 *     settings 段),这张表管**数据文件**(哪些文件、什么形状、怎么校验)。
 *
 * 校验口径(P0 定案,非破坏优先):
 *   - 空值(`''` / `null` / `[]` / `{}`)永远合法 —— 它就是"用户还没填";
 *   - **缺 `schemaRev` 合法**:P0 之前写下的文件(persona.json / config.json)
 *     本来就没有这个键,不许因此判它们坏;
 *   - 类型/范围不对 ⇒ 报 error,但**不动文件**(由 lib/data-dir.js 决定"保留" ——
 *     语义错不许毁用户文本);只有"读都读不出来"(JSON 坏了 / 不是对象)才允许
 *     改名 `.bad-*` 重建;
 *   - 未知键 ⇒ 报 warning,**保留不动**(writeConfig 同款纪律:不丢用户的字段)。
 */
/**
 * persona 两个段落的上限 —— **等于** `lib/persona.js` 的 `PERSONA_MAX_CHARS`(4000)。
 *
 * ⚠️ P1a 起这里**故意不再 `import` persona.js**:persona.js 现在要 import
 * data-dir.js 拿路径,而 data-dir.js → data-schema.js;再让 data-schema.js →
 * persona.js 就成环 —— persona.js 先被加载时,本文件在求值期读它的 `const`
 * 会撞 TDZ 当场 ReferenceError。漂移由 `tests/data-schema.test.js` 的
 * 「同源」用例看住(那里同时 import 两边做等号),不靠 import 边。
 */
const PERSONA_MAX_CHARS = 4000

/** 程序期望的数据版本(每个文件各有一个 schemaRev,初值 1)。 */
export const PROGRAM_DATA_REV = 1

/** 备份子目录名(数据目录下)。 */
export const BACKUP_DIR_NAME = 'backup'

/** 记账文件:不属于"用户填的 8 个数据文件",由程序独占读写。 */
export const DATA_REV_FILE = 'data-rev.json'

// ---------------------------------------------------------------- 类型检查件

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v) => typeof v === 'string'
const isInt = (v) => Number.isInteger(v)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

const TYPES = {
  string: isStr,
  int: isInt,
  number: isNum,
  bool: (v) => typeof v === 'boolean',
  object: isObj,
  array: (v) => Array.isArray(v),
  'string[]': (v) => Array.isArray(v) && v.every(isStr),
  'object[]': (v) => Array.isArray(v) && v.every(isObj)
}

const typeOk = (type, v) => {
  const f = TYPES[type]
  return f === undefined ? false : f(v)
}

// ---------------------------------------------------------------- 字段描述表

/**
 * 遍历一张字段表。
 * 每条:`{ key, type, required?, maxLen?, itemMaxLen?, min?, max?, itemRegex?, nested?, note? }`
 * @returns {{errors: string[], warnings: string[]}}
 */
function checkFields (fields, obj, path) {
  const errors = []
  const warnings = []
  const known = new Set()
  for (const f of fields) {
    known.add(f.key)
    const at = path === '' ? f.key : path + '.' + f.key
    const v = obj[f.key]
    if (v === undefined) {
      if (f.required === true) errors.push(at + ':缺字段(必填)')
      continue
    }
    // 空值 = 用户还没填:非必填字段一律放行(必填字段的 null 才算错)
    if (v === null) {
      if (f.required === true) errors.push(at + ':不许为 null')
      continue
    }
    if (!typeOk(f.type, v)) {
      errors.push(at + ':类型不是 ' + f.type)
      continue
    }
    if (f.maxLen !== undefined && isStr(v) && v.length > f.maxLen) {
      errors.push(at + ':长 ' + v.length + ' 字,超过上限 ' + f.maxLen)
    }
    if (f.itemMaxLen !== undefined && Array.isArray(v)) {
      const bad = v.filter((x) => isStr(x) && x.length > f.itemMaxLen).length
      if (bad > 0) errors.push(at + ':' + bad + ' 条超过单条上限 ' + f.itemMaxLen + ' 字')
    }
    if (f.itemRegex === true && Array.isArray(v)) {
      for (const s of v) {
        if (!isStr(s)) continue
        try { new RegExp(s) } catch { errors.push(at + ':有一条不是合法正则') }
      }
    }
    if (f.min !== undefined && isNum(v) && v < f.min) errors.push(at + ':' + v + ' 小于下限 ' + f.min)
    if (f.max !== undefined && isNum(v) && v > f.max) errors.push(at + ':' + v + ' 大于上限 ' + f.max)
    if (f.nested !== undefined && isObj(v)) {
      const sub = checkFields(f.nested, v, at)
      errors.push(...sub.errors)
      warnings.push(...sub.warnings)
    }
  }
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) warnings.push((path === '' ? k : path + '.' + k) + ':字段表里没有这个键(保留不动)')
  }
  return { errors, warnings }
}

// ---------------------------------------------------------------- 8 个数据文件

/**
 * 每份规格:
 *   schemaRev  程序期望的版本
 *   fields     字段清单(结构真源)
 *   template   空模板(**真空值**,deep-clone 后发给调用方)
 *   extra      字段表管不到的跨字段规矩(可选)
 */
const SPECS = {}

/** config.json —— 面板/宿主写的那份开关与调参。字段表与 lib/toggle.js 的
 *  `defaultConfig()` + `readConfig()` 白名单逐键对齐(缺 schemaRev = 老文件,合法)。 */
SPECS['config.json'] = {
  schemaRev: PROGRAM_DATA_REV,
  fields: [
    { key: 'schemaRev', type: 'int', min: 1, note: '数据版本(P0 起写)' },
    { key: 'enabled', type: 'bool', note: '总闸:在线/休眠' },
    // 2026-10-25（bug-echo-subagent-scope）：all 的准确含义是「所有顶层会话」。
  //   子代理会话永远不在范围内（它们没有开关可拨），判据见 lib/agent-scope.js。
  { key: 'scope', type: 'string', maxLen: 16, note: 'all(所有顶层会话) | whitelist' },
  { key: 'subagentSessions', type: 'string[]', itemMaxLen: 128,
    note: '见过的子代理会话 id（只用于面板展示时过滤；审计照旧记它们的行）' },
    { key: 'whitelist', type: 'string[]', itemMaxLen: 128, note: '白名单会话' },
    { key: 'exempt', type: 'string[]', itemMaxLen: 128, note: '豁免会话' },
    { key: 'manualOff', type: 'string[]', itemMaxLen: 128, note: '人手关掉的会话' },
    { key: 'sessionLabels', type: 'object', note: '会话 → 来源标签' },
    { key: 'poweredBy', type: 'string', maxLen: 24 },
    { key: 'poweredAt', type: 'number', min: 0 },
    { key: 'scopeBy', type: 'string', maxLen: 24 },
    { key: 'scopeAt', type: 'number', min: 0 },
    { key: 'memorySubagentTools', type: 'bool', note: '面板开关:给子代理开只读记忆工具' },
    { key: 'memorySubagentToolsBy', type: 'string', maxLen: 24 },
    { key: 'memorySubagentToolsAt', type: 'number', min: 0 },
    { key: 'graphShadowEdges', type: 'bool', note: '面板开关:自动挖影子边(引擎每帧现读)' },
    { key: 'graphShadowEdgesBy', type: 'string', maxLen: 24 },
    { key: 'graphShadowEdgesAt', type: 'number', min: 0 },
    { key: 'settings', type: 'object', note: '调参段(111 字段;字段表在 lib/settings-fields.js,钳位在 lib/toggle.js)' },
    { key: 'savedAt', type: 'string', nullable: true, note: '最近一次落盘时间' }
  ],
  // 空模板故意只有版本号:配置的"默认值"是 SETTINGS_DEFAULTS 的事,
  // 这里写下去就等于把程序默认值混进用户文件(P0 明令禁止)。
  template: { schemaRev: PROGRAM_DATA_REV }
}

/** persona.json —— 人格模板。空 = 还没填。 */
SPECS['persona.json'] = {
  schemaRev: PROGRAM_DATA_REV,
  fields: [
    { key: 'schemaRev', type: 'int', min: 1 },
    { key: 'prefix', type: 'string', required: true, maxLen: PERSONA_MAX_CHARS, note: '身份段(挂 order 10245)' },
    { key: 'suffix', type: 'string', required: true, maxLen: PERSONA_MAX_CHARS, note: '铁律+说话方式(挂 order 10250)' },
    { key: 'edited', type: 'bool', note: 'true = 用户拥有的文本,迁移永不覆盖' },
    { key: 'savedAt', type: 'string', nullable: true },
    // 老键(P0 之前的文件里有):是"版本记账",不是用户数据,保留不动
    { key: 'defaultsRev', type: 'int', min: 0, note: '旧版:插件写默认时的版本号' }
  ],
  template: { schemaRev: PROGRAM_DATA_REV, prefix: '', suffix: '', edited: false, savedAt: null }
}

/** profile.json —— 用户画像与称呼(称呼链的唯一来源)。 */
SPECS['profile.json'] = {
  schemaRev: PROGRAM_DATA_REV,
  fields: [
    { key: 'schemaRev', type: 'int', min: 1 },
    { key: 'userName', type: 'string', maxLen: 32, note: '他:她想怎么叫他' },
    { key: 'userAliases', type: 'string[]', itemMaxLen: 32, note: '他:其它叫法(旧名/小号)' },
    { key: 'agentName', type: 'string', maxLen: 32, note: '她:名字(显示层)' },
    { key: 'agentSelfRef', type: 'string', maxLen: 32, note: '她:自称' },
    { key: 'agentAliases', type: 'string[]', itemMaxLen: 32, note: '她:别的叫法(识别层 —— 认"这是她在说自己",喂 toggle 的 SELF_WORDS;显示层只用 agentName)' },
    { key: 'nicknamePatterns', type: 'string[]', itemMaxLen: 256, itemRegex: true, note: '剥信封用的昵称正则(可由 userAliases 生成)' },
    { key: 'nicknameStrict', type: 'bool', note: '正则是否严格匹配' },
    // P2 §6.2 ④ 称呼与显示(2026-10-05):这两项原来写死在 web/app.js 里
    // (「对XX」的前缀、拿不到名字时的中性兜底词)—— 搬到数据里,空 = 用默认。
    { key: 'uiIndexPrefix', type: 'string', maxLen: 8, note: 'UI 索引前缀(情绪标题那类"对XX";空 = 用默认「对」)' },
    { key: 'fallbackAddress', type: 'string', maxLen: 32, note: '兜底称呼(面板拿不到名字时显示;空 = 用中性「用户」)' },
    { key: 'locale', type: 'string', maxLen: 16 },
    { key: 'timezone', type: 'string', maxLen: 64 },
    { key: 'updatedAt', type: 'string', nullable: true }
  ],
  template: {
    schemaRev: PROGRAM_DATA_REV,
    userName: '',
    userAliases: [],
    agentName: '',
    agentSelfRef: '',
    agentAliases: [],
    nicknamePatterns: [],
    nicknameStrict: null,
    uiIndexPrefix: '',
    fallbackAddress: '',
    locale: '',
    timezone: '',
    updatedAt: null
  }
}

/** aliases.json —— 图谱实体别名表(规则形状与 lib/graph-aliases.js 的 {alias,canonical,why} 同源)。 */
SPECS['aliases.json'] = {
  schemaRev: PROGRAM_DATA_REV,
  fields: [
    { key: 'schemaRev', type: 'int', min: 1 },
    { key: 'rules', type: 'object[]', note: '每条:{ alias, canonical, tier(1|2), why }', itemFields: [
      { key: 'alias', type: 'string', note: '别名' }, { key: 'canonical', type: 'string', note: '规范称呼' },
      { key: 'tier', type: 'number', note: '层级（1或2）' }, { key: 'why', type: 'string', note: '说明' }
    ] },
    { key: 'updatedAt', type: 'string', nullable: true }
  ],
  template: { schemaRev: PROGRAM_DATA_REV, rules: [], updatedAt: null },
  extra (obj, errors, warnings) {
    const rules = Array.isArray(obj.rules) ? obj.rules : []
    rules.forEach((r, i) => {
      const at = 'rules[' + i + ']'
      if (!isObj(r)) { errors.push(at + ':不是对象'); return }
      if (!isStr(r.alias) || r.alias.trim() === '') errors.push(at + '.alias:空')
      if (!isStr(r.canonical) || r.canonical.trim() === '') errors.push(at + '.canonical:空')
      if (r.tier !== 1 && r.tier !== 2) errors.push(at + '.tier:只能是 1 或 2')
      if (r.why !== undefined && !isStr(r.why)) errors.push(at + '.why:不是字符串')
      if (isStr(r.alias) && r.alias.length > 64) errors.push(at + '.alias:超过 64 字')
      if (isStr(r.canonical) && r.canonical.length > 64) errors.push(at + '.canonical:超过 64 字')
      for (const k of Object.keys(r)) {
        if (!['alias', 'canonical', 'tier', 'why'].includes(k)) warnings.push(at + '.' + k + ':字段表里没有这个键(保留不动)')
      }
    })
  }
}

/** names.json —— 人名/说话人集合(引擎闸门与共现图的输入)。 */
SPECS['names.json'] = {
  schemaRev: PROGRAM_DATA_REV,
  fields: [
    { key: 'schemaRev', type: 'int', min: 1 },
    { key: 'speakers', type: 'string[]', itemMaxLen: 32, note: '说话人(共现图的节点池)' },
    { key: 'personNames', type: 'string[]', itemMaxLen: 32, note: '语义上算"人"的名字(方向判定用)' },
    { key: 'ownerNames', type: 'string[]', itemMaxLen: 32, note: '自节点名 —— 只有他真的会被这么叫(P1c:喂 python 的 l0_tier;空 ⇒ 由 profile.json 的 userName/userAliases 派生,再空就只剩角色槽「用户」)' },
    { key: 'familyTerms', type: 'string[]', itemMaxLen: 32, note: '家人称谓等' },
    { key: 'updatedAt', type: 'string', nullable: true }
  ],
  template: { schemaRev: PROGRAM_DATA_REV, speakers: [], personNames: [], ownerNames: [], familyTerms: [], updatedAt: null }
}

/** graph.json —— 图论配置:B 档(可调刻度)外置,纯算法常量仍留程序。 */
SPECS['graph.json'] = {
  schemaRev: PROGRAM_DATA_REV,
  fields: [
    { key: 'schemaRev', type: 'int', min: 1 },
    {
      key: 'weights',
      type: 'object',
      note: '打分权重',
      nested: [
        { key: 'wUnstale', type: 'number' },
        { key: 'wSpecificity', type: 'number' },
        { key: 'wEmotion', type: 'number' }
      ]
    },
    {
      key: 'thresholds',
      type: 'object',
      nested: [
        { key: 'topic', type: 'number' },
        { key: 'thread', type: 'number' },
        { key: 'memory', type: 'number' },
        { key: 'stateFuzzy', type: 'number' },
        { key: 'stateForgotten', type: 'number' }
      ]
    },
    {
      key: 'windows',
      type: 'object',
      nested: [
        { key: 'candidateHours', type: 'number', min: 0 },
        { key: 'cooldownMin', type: 'number', min: 0 },
        // P3-d(#18 夜闸,§2.1 row 18):夜里"压住主动开口"的钟点窗口初值。
        // 出厂兜底在 lib/heartbeat.js 的 NIGHT_HOLD_FROM_HOUR / TO_HOUR(23 / 8)。
        { key: 'nightHoldFromHour', type: 'number', min: 0, max: 23, note: '夜闸起点(0~23;空/坏/越界 ⇒ 回出厂 23)' },
        { key: 'nightHoldToHour', type: 'number', min: 0, max: 23, note: '夜闸终点(0~23;空/坏/越界 ⇒ 回出厂 8)' }
      ]
    },
    {
      key: 'relations',
      type: 'object',
      note: '谓词/关系表(P1 从 python/engine/relations.py 等导入)',
      nested: [
        // B2-1 定形(2026-10-05,以消费侧为准):引擎 `relations._type_rules()`
        // 的**主形状**是对象数组 `[{ relation, pairs }]`(python/engine/relations.py:197-291
        // 同时容错认 ②扁平对象 ③名字数组)⇒ 面板照主形状写,schema 跟着改成 `object[]`。
        { key: 'typeRules', type: 'object[]', note: '类型规则,每条 { relation, pairs[] };旧的字面名字数组读侧仍认', itemFields: [
          { key: 'relation', type: 'string', note: '关系名称' }, { key: 'pairs', type: 'array', note: '类型配对' }
        ] },
        { key: 'singleValue', type: 'string[]', itemMaxLen: 32 },
        // P3-a 预置:两个新子字段(关系表里"多值键"与"身份类谓词"两份名单)。
        { key: 'multiValueKeys', type: 'string[]', itemMaxLen: 32, note: '多值关系键(python/engine/relations.py:62-66)' },
        { key: 'identityRelations', type: 'string[]', itemMaxLen: 32, note: '身份类谓词(python/engine/l0_tier.py:76-83)' },
        // P3-a 定形(拍板 6「以代码用法为准」):引擎侧 `relations.CANONICAL_RELATION`
        // 就是 `{现场写法: 规范写法}` 的 **map**(python/engine/relations.py:103-121,
        // 靠"值==键"认自映射)⇒ 从误写的 `object[]` 改成 `object`。
        { key: 'canonical', type: 'object' },
        { key: 'pending', type: 'object[]' },
        { key: 'defaultRelation', type: 'string', maxLen: 32 }
      ]
    },
    {
      key: 'display',
      type: 'object',
      note: '仪表盘图谱页的显示调参(现在硬编码在 web/graph.html)',
      nested: [
        { key: 'wMin', type: 'number' },
        { key: 'wMax', type: 'number' },
        { key: 'radiusBase', type: 'number' },
        { key: 'radiusScale', type: 'number' },
        { key: 'edgeWidthMin', type: 'number' },
        { key: 'edgeWidthMax', type: 'number' },
        { key: 'flowSlowSec', type: 'number', min: 0 },
        { key: 'flowFastSec', type: 'number', min: 0 },
        { key: 'enterDelayMaxMs', type: 'number', min: 0 }
      ]
    },
    { key: 'updatedAt', type: 'string', nullable: true }
  ],
  template: {
    schemaRev: PROGRAM_DATA_REV,
    weights: {},
    thresholds: {},
    windows: {},
    relations: {},
    display: {},
    updatedAt: null
  }
}

/** state-defaults.json —— 状态机初值(情绪/好感/想念)。只影响**新建**的状态行。 */
SPECS['state-defaults.json'] = {
  schemaRev: PROGRAM_DATA_REV,
  fields: [
    { key: 'schemaRev', type: 'int', min: 1 },
    { key: 'moodIntensity', type: 'number', min: 0, note: '情绪强度初值(store.js 的 agent_state)' },
    { key: 'prevMoodIntensity', type: 'number', min: 0 },
    { key: 'userEmotion', type: 'string', maxLen: 32, note: '他此刻情绪的初值标签' },
    { key: 'emotionVector', type: 'object', note: '7 维情绪向量初值(lib/emotion.js)' },
    { key: 'affinity', type: 'number', min: 0, note: '好感度初值(user_profile)' },
    { key: 'longing', type: 'number', min: 0, note: '想念值初值(longing_state)' },
    { key: 'energy', type: 'number', min: 0 },
    { key: 'updatedAt', type: 'string', nullable: true }
  ],
  template: {
    schemaRev: PROGRAM_DATA_REV,
    moodIntensity: null,
    prevMoodIntensity: null,
    userEmotion: null,
    emotionVector: null,
    affinity: null,
    longing: null,
    energy: null,
    updatedAt: null
  }
}

/** lexicon.json —— 词表(禁词/兴趣/同义词/时间词/停用词)。 */
SPECS['lexicon.json'] = {
  schemaRev: PROGRAM_DATA_REV,
  fields: [
    { key: 'schemaRev', type: 'int', min: 1 },
    { key: 'synonymGroups', type: 'array', note: '同义词组:[[a,b],[c,d,e]];程序内没有内置同义词对(见 synonyms.py)' },
    { key: 'timeWords', type: 'object', note: '中文时间词表(键对齐 python/engine/timeintent.py 的 6 张表)' },
    { key: 'bannedWords', type: 'string[]', itemMaxLen: 32, note: '禁词(settings 里同名项留空时曾隐式回落到代码内置表)' },
    { key: 'herInterests', type: 'string[]', itemMaxLen: 64 },
    { key: 'retiredAliases', type: 'string[]', itemMaxLen: 32, note: '旧称呼(改名后自动记)' },
    { key: 'stopwords', type: 'string[]', itemMaxLen: 32, note: '停用词(python/engine 的 STOPWORDS)' },
    // P3-a 预置(B 批要用):三个新字段的形状先定死,免得四批代理各写各的。
    { key: 'topicStopwords', type: 'string[]', itemMaxLen: 32, note: '主题停用词(lib/care-report.js 的 TOPIC_STOPWORDS);空 ⇒ 回代码里的语言默认表' },
    { key: 'powerWords', type: 'object', note: '{off:[…],on:[…]} —— lib/toggle.js 的开关词;空 / 缺键 ⇒ 回代码默认表' },
    { key: 'longingMarkers', type: 'string[]', itemMaxLen: 16, note: '思念**词根**(lib/turn-stopping.js);含称呼的两条由 profile.userName 运行时拼,不落盘' },
    { key: 'updatedAt', type: 'string', nullable: true }
  ],
  template: {
    schemaRev: PROGRAM_DATA_REV,
    synonymGroups: [],
    timeWords: {},
    bannedWords: [],
    herInterests: [],
    retiredAliases: [],
    stopwords: [],
    topicStopwords: [],
    powerWords: {},
    longingMarkers: [],
    updatedAt: null
  },
  extra (obj, errors) {
    const groups = obj.synonymGroups
    if (groups === undefined || groups === null) return
    if (!Array.isArray(groups)) { errors.push('synonymGroups:不是数组'); return }
    groups.forEach((g, i) => {
      if (!Array.isArray(g)) { errors.push('synonymGroups[' + i + ']:不是数组'); return }
      if (g.length < 2) errors.push('synonymGroups[' + i + ']:至少两个字才算一组')
      if (!g.every(isStr)) errors.push('synonymGroups[' + i + ']:有非字符串项')
    })
  }
}

/** 记账文件(程序独占):版本 + 迁移记录 + 上次体检时间。 */
const DATA_REV_SPEC = {
  schemaRev: PROGRAM_DATA_REV,
  fields: [
    { key: 'dataRev', type: 'int', min: 1, required: true, note: '数据目录版本' },
    { key: 'createdAt', type: 'string', nullable: true, note: '首次 scaffold 时间' },
    { key: 'appliedMigrations', type: 'string[]', note: '已应用的一次性迁移标记' },
    { key: 'lastCheckAt', type: 'string', nullable: true, note: '最近一次体检时间' },
    { key: 'notes', type: 'string[]', note: '程序留的备注(人可读)' }
  ],
  template: {
    dataRev: PROGRAM_DATA_REV,
    createdAt: null,
    appliedMigrations: [],
    lastCheckAt: null,
    notes: []
  }
}

/**
 * persona-legacy-defaults.json —— 插件**历史默认人格**的只读史料(P1b 模块1 的迁移产物)。
 *
 * 它不是"用户填的数据",是**程序写、程序读**的档案:程序里不再有人格文本之后,
 * "认出一份 persona.json 是插件写的旧默认、不是他写的"就靠它
 * (lib/persona.js 的 classifyPersonaFile)。P1b 起程序永不写回、永不覆盖用户文本。
 *
 * 与那 8 个数据文件的区别(2026-10-05 拍板):
 *   · **不参与建仓** —— 新装凭空造一份"历史默认"没有意义,所以它不在 DATA_FILES 里;
 *   · **参与体检** —— 它确实住在数据目录里,就该能被校验(reason:数据目录里的文件
 *     绕过校验,是"数据与程序分离"要收掉的那种隐式角落)。
 */
export const ARCHIVE_FILES = Object.freeze(['persona-legacy-defaults.json'])

SPECS['persona-legacy-defaults.json'] = {
  schemaRev: PROGRAM_DATA_REV,
  fields: [
    { key: 'schemaRev', type: 'int', min: 1 },
    { key: 'kind', type: 'string', note: '固定 persona-legacy-defaults(认档案类型的锚)' },
    { key: 'legacyDefault', type: 'bool', note: 'true = 档里的文本属"插件默认",不等于他写的' },
    { key: 'note', type: 'string', nullable: true },
    { key: 'finalDefaultsRev', type: 'int', min: 0, note: '最后一版默认的 rev(与 lib/persona.js 的 DEFAULTS_REV 同源)' },
    { key: 'finalDefault', type: 'object', note: '{ prefix, suffix } —— 最后一版默认原文' },
    { key: 'staleDefaults', type: 'array', note: '[{ rev, prefix, suffix }] 冻结的更旧几版默认' },
    { key: 'archivedAt', type: 'string', nullable: true },
    { key: 'source', type: 'string', nullable: true, note: '从哪份代码抄的(可追溯)' }
  ],
  template: {
    schemaRev: PROGRAM_DATA_REV,
    kind: 'persona-legacy-defaults',
    legacyDefault: true,
    note: '',
    finalDefaultsRev: 0,
    finalDefault: { prefix: '', suffix: '' },
    staleDefaults: [],
    archivedAt: null,
    source: ''
  }
}

/** 用户填的 8 个数据文件(顺序 = 建仓顺序 = 体检顺序)。 */
export const DATA_FILES = Object.freeze([
  'config.json',
  'persona.json',
  'profile.json',
  'aliases.json',
  'names.json',
  'graph.json',
  'state-defaults.json',
  'lexicon.json'
])

/** 全部受管文件(8 个数据文件 + 档案文件 + 记账文件)。 */
export const MANAGED_FILES = Object.freeze([...DATA_FILES, ...ARCHIVE_FILES, DATA_REV_FILE])

// ---------------------------------------------------------------- 对外接口

/** 取一份文件的规格(没登记过返回 null)。 */
export function specOf (name) {
  if (name === DATA_REV_FILE) return DATA_REV_SPEC
  return SPECS[name] ?? null
}

/** 程序期望的 schemaRev(没登记过返回 null)。 */
export function expectedRev (name) {
  const spec = specOf(name)
  return spec === null ? null : spec.schemaRev
}

/** 字段清单的浅拷贝(给仪表盘/P1 的配置中心用;别改它)。 */
export function fieldsOf (name) {
  const spec = specOf(name)
  return spec === null ? null : spec.fields.map((f) => ({ ...f }))
}

/** 空模板的**深拷贝**(每次调用都是新的:调用方随便改)。 */
export function emptyTemplate (name) {
  const spec = specOf(name)
  return spec === null ? null : structuredClone(spec.template)
}

/** 版本检查:缺 = 老文件(警告);比程序新 = 只警告、不动它;比程序旧 = 警告(等迁移)。 */
export function checkSchemaRev (obj, expected = PROGRAM_DATA_REV) {
  const errors = []
  const warnings = []
  const raw = isObj(obj) ? obj.schemaRev : undefined
  if (raw === undefined || raw === null) {
    warnings.push('缺 schemaRev(P0 之前的文件,按当前版本读)')
  } else if (!isInt(raw) || raw < 1) {
    errors.push('schemaRev 不是正整数:' + JSON.stringify(raw))
  } else if (raw > expected) {
    warnings.push('文件版本 ' + raw + ' 比程序期望的 ' + expected + ' 新 —— 不降级、不动它')
  } else if (raw < expected) {
    warnings.push('文件版本 ' + raw + ' 落后于 ' + expected + '(等一次性迁移补)')
  }
  return { ok: errors.length === 0, errors, warnings }
}

/**
 * 校验一个数据文件的内容。
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateFile (name, obj) {
  const spec = specOf(name)
  if (spec === null) return { ok: false, errors: ['没有登记过的文件:' + name], warnings: [] }
  if (!isObj(obj)) return { ok: false, errors: ['顶层不是 JSON 对象'], warnings: [] }
  const { errors, warnings } = checkFields(spec.fields, obj, '')
  const rev = checkSchemaRev(obj, spec.schemaRev)
  errors.push(...rev.errors)
  warnings.push(...rev.warnings)
  if (typeof spec.extra === 'function') spec.extra(obj, errors, warnings)
  return { ok: errors.length === 0, errors, warnings }
}

/** "这个对象是不是坏得连读都读不出来" —— 只有这种才允许重建(见文件头)。 */
export function isUnreadable (obj) {
  return !isObj(obj)
}

/** 记账文件的空模板。 */
export function dataRevTemplate () {
  return structuredClone(DATA_REV_SPEC.template)
}
