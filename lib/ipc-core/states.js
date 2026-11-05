/**
 * 关系状态词表：用现成的关系词把「现在是什么关系」说白了。
 *
 * ## 这一层干什么
 *
 * `lexicon.js` 那 33 条是**单方姿态**（一个人怎么跟对方相处）。本模块是**关系状态**
 * （两个人之间是什么样：亲密袒露与交流、不冷不热、忍气吞声……）。粒度不同，分开放。
 *
 * ## 覆盖面是硬要求
 *
 * 要求是「**每一个范围都有词**」。所以这张表按
 * `亲近度档（高/中/低）× 主导性（相当/一方拿主意）` 两个方向铺满，
 * 并且每个档里的词要横跨多个**维度**（见 `facet`）——否则并列展示时会列出一串近义说法。
 * `test/core.test.js` 里有一条**扫描整个范围**的护栏：亲近度从 0.4 扫到 1.0、
 * 主导性差从 0 扫到 0.6，任何一格都必须至少给得出 4 个词（两人都在中心除外）。
 * 那条测试是这一层唯一真正重要的验收标准。
 *
 * ## 出处分两级（数据里保留，界面上不显示）
 *
 * - `termProvenance: 'literature'`：词是**已核实的中文量表维度名**，`source` 给出量表与文献。
 * - `termProvenance: 'estimated'`：**本项目整理的说法**，没有单一文献出处。
 *   用户明确说过不必死抠原著、合理的关系状态词就收——这一类就是为此存在的。
 * - `mappingProvenance` 恒为 `'estimated'`：**「它属于哪一档」是本项目的映射**，
 *   量表维度名不是坐标，文献里没有这个信息。
 *
 * ⚠️ 能引用的只有词和它的出处，不能引用位置。
 *
 * ## 界面只显示 `meaning`
 *
 * 面板的 `?` 弹窗只放一句大白话解释——用户要的是「这是什么意思」，不是出处。
 *
 * @module dsh-interpersonal-circumplex/core/states
 */

/** 词的出处。只在工具输出与自检里用，不进弹窗。 */
const S = Object.freeze({
  friend6: Object.freeze({
    scale: '友谊质量问卷（FQQ，Parker & Asher；周宗奎等修订）六维',
    ref: '肯定与关心、帮助与指导、陪伴与娱乐、亲密袒露与交流、冲突解决策略、冲突与背叛',
  }),
  friend5: Object.freeze({
    scale: '青少年友谊质量问卷（Parker & Asher 1993；邹泓 1998；万晶晶、周宗奎 2002）五维',
    ref: '陪伴帮助、亲密交流、肯定价值、冲突背叛、信任尊重',
  }),
  friendCommon: Object.freeze({
    scale: '友谊质量通用维度词（中文文献常用）',
    ref: '支持性、亲密性、自我暴露、敌意',
  }),
  zou: Object.freeze({
    scale: '邹泓（2006）友谊关系四方面',
    ref: '关心与帮助、重情轻利、信任与尊重、兴趣相投',
  }),
  teacher: Object.freeze({
    scale: '王耘、王晓华、张红川（2001）师生关系三维，《心理发展与教育》17(3):16–21',
    ref: '冲突性、亲密性、反应性',
  }),
  parent: Object.freeze({
    scale: '吴继霞等（2011）中学生亲子关系问卷，《西南大学学报(社科版)》37(4)',
    ref: '理解沟通、苛责干涉',
  }),
  family: Object.freeze({
    scale: '家庭亲密度和适应性量表（FACES，费立鹏等修订）/ 家庭环境量表 FES-CV',
    ref: '亲密度、适应性、矛盾性、娱乐性',
  }),
  quality: Object.freeze({
    scale: '侯静、宋蕾《大学生情侣成人依恋与亲密关系质量》里对关系质量的定义性描述词',
    ref: '满意度、承诺、亲密、愉悦、稳定、牢固（是描述，不是因子分析出来的维度名）',
  }),
  trust: Object.freeze({
    scale: '李红菊、许燕、郭永玉（2007）人际信任，《心理发展与教育》23(3):112–116',
    ref: '信任—不信任（单维）',
  }),
  nri: Object.freeze({
    scale: 'Network of Relationships Inventory（Furman & Buhrmester）官方手册',
    ref: 'Relative power、Conflict、Antagonism 等',
  }),
  nriRqv: Object.freeze({
    scale: 'NRI-RQV（Buhrmester & Furman 2008）',
    ref: 'Criticism、Dominance、Exclusion、Pressure、Approval',
  }),
  qri: Object.freeze({
    scale: 'Quality of Relationships Inventory（Pierce, Sarason & Sarason）',
    ref: 'Support、Conflict、Depth',
  }),
  investment: Object.freeze({
    scale: '投资模型（Rusbult）；中文版见刘新春等（2015）《中国临床心理学杂志》',
    ref: '满意度、替代性、投资量、承诺',
  }),
  own: Object.freeze({
    scale: '本项目整理的关系状态说法（无单一文献出处）',
    ref: '补文献词没覆盖到的范围，尤其是「中间档」与各档的主导性差异',
  }),
});

/** 维度清单。同一维度里的词是近义，并列展示时每个维度最多取一个。 */
export const FACETS = Object.freeze([
  '交心深度', '关心与温度', '共同活动', '肯定与尊重', '支持与依靠', '信任与坦白',
  '稳定与承诺', '冲突与攻击', '权力与支配', '冷待与排斥', '距离与分寸',
  '互惠与付出', '依赖与自主', '安心与消耗',
]);

/**
 * 词表。每行：`[id, 中文, 英文, 出处, 亲近度档, 主导性, 出处等级, 维度, 一句解释]`。
 *
 * - 亲近度档：`high` / `mid` / `low` / `any`（与亲近度无关）
 * - 主导性：`asymmetric`（一方明显拿主意）/ `even`（相当）/ `any`
 * @type {ReadonlyArray<object>}
 */
export const STATES = Object.freeze([
  // ============================================================ 亲近度高 · high
  ...[
    // ---- 交心深度
    ['intimate-disclosure', '亲密袒露与交流', 'Intimate disclosure', S.friend6, 'high', 'any', 'literature', '交心深度', '愿意把私事和心里话告诉对方'],
    ['intimate-exchange', '亲密交流', 'Intimate exchange', S.friend5, 'high', 'any', 'literature', '交心深度', '说得到一块儿，能说心里话'],
    ['closeness', '亲密性', 'Closeness', S.friendCommon, 'high', 'any', 'literature', '交心深度', '距离近，彼此不设防'],
    ['self-disclosure', '自我暴露', 'Self-disclosure', S.friendCommon, 'high', 'any', 'literature', '交心深度', '敢说自己的弱点与私事'],
    ['depth', '关系深', 'Depth', S.qri, 'high', 'any', 'literature', '交心深度', '牵连多、放不下'],
    ['confidant', '知心', 'Confidant', S.own, 'high', 'any', 'estimated', '交心深度', '什么都能说，对方也懂'],
    ['open-heart', '交心', 'Open-hearted', S.own, 'high', 'any', 'estimated', '交心深度', '把心里话交给对方'],
    ['nothing-unsaid', '无话不谈', 'Nothing unsaid', S.own, 'high', 'any', 'estimated', '交心深度', '没有不能说的'],
    ['intimate', '亲密', 'Intimate', S.own, 'high', 'any', 'estimated', '交心深度', '关系近，说话不用绕'],
    // ---- 关心与温度
    ['affirmation-care', '肯定与关心', 'Affirmation & care', S.friend6, 'high', 'any', 'literature', '关心与温度', '记得对方的事，会称赞，也挂念'],
    ['care-help', '关心与帮助', 'Care & help', S.zou, 'high', 'any', 'literature', '关心与温度', '在意对方，也肯出手'],
    ['sentiment-over-gain', '重情轻利', 'Sentiment over gain', S.zou, 'high', 'any', 'literature', '关心与温度', '讲情分，不计较得失'],
    ['considerate', '贴心', 'Considerate', S.own, 'high', 'any', 'estimated', '关心与温度', '能想到对方前头'],
    ['caring', '关心', 'Caring', S.own, 'high', 'any', 'estimated', '关心与温度', '在意对方的处境'],
    ['thinking-of', '惦记', 'Thinking of', S.own, 'high', 'any', 'estimated', '关心与温度', '不在一起时也会想着对方'],
    ['protective', '保护', 'Protective', S.own, 'high', 'any', 'estimated', '关心与温度', '有事你会替他挡'],
    ['lively', '热络', 'Lively', S.own, 'high', 'any', 'estimated', '关心与温度', '来往勤、话说得多'],
    ['attentive', '重视', 'Attentive', S.own, 'high', 'any', 'estimated', '关心与温度', '把对方的事放在心上'],
    ['spoiling', '宠爱', 'Spoiling', S.own, 'high', 'asymmetric', 'estimated', '关心与温度', '你愿意惯着他、让着他'],
    // ---- 共同活动
    ['companionship-play', '陪伴与娱乐', 'Companionship & play', S.friend6, 'high', 'any', 'literature', '共同活动', '常一起玩、一起打发时间'],
    ['companionship-help', '陪伴帮助', 'Companionship & aid', S.friend5, 'high', 'any', 'literature', '共同活动', '常在一起，也搭得上手'],
    ['shared-interest', '兴趣相投', 'Shared interests', S.zou, 'high', 'any', 'literature', '共同活动', '喜欢的东西接近，玩得到一起'],
    ['family-recreation', '娱乐性', 'Recreation', S.family, 'high', 'any', 'literature', '共同活动', '一起活动，有乐趣'],
    ['congenial', '投缘', 'Congenial', S.own, 'high', 'any', 'estimated', '共同活动', '一相处就合得来'],
    ['companions', '同好', 'Companions', S.own, 'high', 'any', 'estimated', '共同活动', '有共同活动，凑一起自在'],
    ['side-by-side', '并肩', 'Side by side', S.own, 'high', 'even', 'estimated', '共同活动', '站在同一边，一起往前'],
    // ---- 肯定与尊重
    ['worth-affirmation', '肯定价值', 'Affirmation of worth', S.friend5, 'high', 'any', 'literature', '肯定与尊重', '让对方觉得自己被看重'],
    ['trust-respect', '信任尊重', 'Trust & respect', S.friend5, 'high', 'any', 'literature', '肯定与尊重', '信得过，也不轻慢对方'],
    ['responsiveness', '反应性', 'Responsiveness', S.teacher, 'high', 'any', 'literature', '肯定与尊重', '对方一有动静就有回应'],
    ['understanding-communication', '理解沟通', 'Understanding', S.parent, 'high', 'any', 'literature', '肯定与尊重', '说得通，能被理解'],
    ['approval', '认可', 'Approval', S.nriRqv, 'high', 'any', 'literature', '肯定与尊重', '对方做的事，他认'],
    // ---- 支持与依靠
    ['supportiveness', '支持性', 'Supportiveness', S.friendCommon, 'high', 'any', 'literature', '支持与依靠', '需要时站在对方那边'],
    ['help-guidance', '指导', 'Help & guidance', S.friend6, 'high', 'asymmetric', 'literature', '支持与依靠', '你会教他、帮他办成事'],
    ['family-cohesion', '亲密度', 'Cohesion', S.family, 'high', 'any', 'literature', '支持与依靠', '关系紧密，彼此牵连'],
    ['dependable', '可靠', 'Dependable', S.own, 'high', 'any', 'estimated', '支持与依靠', '需要时对方一定在'],
    // ---- 信任与坦白
    ['trust', '信任', 'Trust', S.trust, 'high', 'any', 'literature', '信任与坦白', '相信对方不会害自己'],
    ['candid', '坦白', 'Candid', S.own, 'high', 'any', 'estimated', '信任与坦白', '有话直说，不藏着'],
    ['unguarded', '不设防', 'Unguarded', S.own, 'high', 'any', 'estimated', '信任与坦白', '不用防着对方'],
    // ---- 稳定与承诺
    ['satisfaction', '满意度', 'Satisfaction', S.investment, 'high', 'any', 'literature', '稳定与承诺', '对这段关系总体满意'],
    ['commitment', '承诺', 'Commitment', S.investment, 'high', 'any', 'literature', '稳定与承诺', '打算长期维持下去'],
    ['pleasure', '愉悦', 'Pleasure', S.quality, 'high', 'any', 'literature', '稳定与承诺', '相处本身就让人愉快'],
    ['stability', '稳定', 'Stability', S.quality, 'high', 'any', 'literature', '稳定与承诺', '不容易晃、不容易散'],
    ['solidity', '牢固', 'Solidity', S.quality, 'high', 'any', 'literature', '稳定与承诺', '经得起冲突和时间'],
    ['family-adaptability', '适应性', 'Adaptability', S.family, 'high', 'any', 'literature', '稳定与承诺', '遇到变化能一起调整'],
    ['long-haul', '长久', 'Long-haul', S.own, 'high', 'any', 'estimated', '稳定与承诺', '打算一直这样下去'],
    ['exclusive', '专属', 'Exclusive', S.own, 'high', 'any', 'estimated', '稳定与承诺', '这种亲近只给对方'],
    // ---- 冲突与攻击（关系好也会有，重点是能收场）
    ['conflict-resolution', '冲突解决策略', 'Conflict resolution', S.friend6, 'high', 'any', 'literature', '冲突与攻击', '吵了也能谈开、能收场'],
    ['make-up', '和好如初', 'Making up', S.own, 'high', 'any', 'estimated', '冲突与攻击', '吵完能回到原来的样子'],
    // ---- 互惠与付出
    ['mutual-giving', '有来有往', 'Mutual giving', S.own, 'high', 'any', 'estimated', '互惠与付出', '你对我好，我也对你好'],
    ['mutual-nurture', '彼此成就', 'Mutual growth', S.own, 'high', 'any', 'estimated', '互惠与付出', '在对方身上变得更好'],
    ['reciprocated', '互相扶持', 'Reciprocal support', S.own, 'high', 'even', 'estimated', '互惠与付出', '一起使劲，互相托着'],
    // ---- 依赖与自主
    ['reliant', '依赖', 'Reliant', S.own, 'high', 'asymmetric', 'estimated', '依赖与自主', '你离不开他，要靠着他'],
    ['leaned-on', '被依赖', 'Leaned on', S.own, 'high', 'asymmetric', 'estimated', '依赖与自主', '他离不开你'],
    // ---- 安心与消耗
    ['secure-feeling', '安心', 'Secure', S.own, 'high', 'any', 'estimated', '安心与消耗', '在对方这儿不紧张'],
    ['at-ease', '相处自在', 'At ease', S.own, 'high', 'any', 'estimated', '安心与消耗', '不用费劲撑着'],
    ['nourishing', '互相滋养', 'Nourishing', S.own, 'high', 'any', 'estimated', '安心与消耗', '相处之后精神变好'],
  ].map(([id, zh, en, source, closeness, agency, termProvenance, facet, meaning]) => Object.freeze({
    id, zh, en, source, closeness, agency, termProvenance, facet, meaning,
    mappingProvenance: 'estimated',
    note: termProvenance === 'literature'
      ? '词与出处为已核实的中文量表维度名；归到哪一档是本项目的映射。'
      : '本项目整理的说法，无单一文献出处；归到哪一档是本项目的映射。',
  })),

  // ============================================================ 亲近度中 · mid
  ...[
    // ---- 距离与分寸
    ['polite', '客气', 'Polite', S.own, 'mid', 'any', 'estimated', '距离与分寸', '有礼貌，留着分寸'],
    ['nodding-acquaintance', '点头之交', 'Nodding acquaintance', S.own, 'mid', 'any', 'estimated', '距离与分寸', '认识，仅此而已'],
    ['casual-acquaintance', '泛泛之交', 'Casual acquaintance', S.own, 'mid', 'any', 'estimated', '距离与分寸', '见面能聊，但不深交'],
    ['acquaintance', '熟人', 'Acquaintance', S.own, 'mid', 'any', 'estimated', '距离与分寸', '能搭话，但不交心'],
    ['with-boundaries', '有分寸', 'With boundaries', S.own, 'mid', 'any', 'estimated', '距离与分寸', '算熟，但留着界线'],
    ['half-familiar', '浅交', 'Half familiar', S.own, 'mid', 'any', 'estimated', '距离与分寸', '比陌生熟，比朋友远'],
    ['colleague-like', '同事式', 'Colleague-like', S.own, 'mid', 'any', 'estimated', '距离与分寸', '一起共事，私下不往来'],
    ['average-relationship', '关系一般', 'Average', S.own, 'mid', 'any', 'estimated', '距离与分寸', '说不上好，也说不上坏'],
    ['maintain-distance', '保持距离', 'Maintaining distance', S.own, 'mid', 'any', 'estimated', '距离与分寸', '客客气气，不越界'],
    ['separate-lives', '各自生活', 'Separate lives', S.own, 'mid', 'any', 'estimated', '距离与分寸', '互不打扰，各自生活'],
    ['seasonal', '阶段性来往', 'Seasonal', S.own, 'mid', 'any', 'estimated', '距离与分寸', '一阵热络一阵不联系'],
    // ---- 交心深度
    ['reserved', '有保留', 'Reserved', S.own, 'mid', 'any', 'estimated', '交心深度', '说事可以，说心里话不行'],
    ['surface-only', '只谈表面', 'Surface only', S.own, 'mid', 'any', 'estimated', '交心深度', '聊的都是不痛不痒的事'],
    ['partial-open', '部分敞开', 'Partially open', S.own, 'mid', 'any', 'estimated', '交心深度', '有些事说，有些事不说'],
    // ---- 关心与温度
    ['lukewarm', '不冷不热', 'Lukewarm', S.own, 'mid', 'any', 'estimated', '关心与温度', '没有热情，也没有敌意'],
    ['polite-concern', '礼貌关心', 'Polite concern', S.own, 'mid', 'any', 'estimated', '关心与温度', '问候到了，但不走心'],
    ['formal-civility', '礼数周到', 'Civility', S.own, 'mid', 'any', 'estimated', '关心与温度', '礼数不缺，热乎没有'],
    ['measured-warmth', '点到为止', 'Measured', S.own, 'mid', 'any', 'estimated', '关心与温度', '关心给到，但不多给'],
    // ---- 共同活动
    ['contact-when-needed', '有事才联系', 'Contact as needed', S.own, 'mid', 'any', 'estimated', '共同活动', '没事不联系，有事说一声'],
    ['occasional-meet', '偶尔小聚', 'Occasional', S.own, 'mid', 'any', 'estimated', '共同活动', '隔一阵见一次，不算亲近'],
    ['functional-tie', '事务往来', 'Functional tie', S.own, 'mid', 'any', 'estimated', '共同活动', '一起办事，办完就散'],
    // ---- 肯定与尊重
    ['courteous-regard', '客气相待', 'Courteous', S.own, 'mid', 'any', 'estimated', '肯定与尊重', '面上尊重，谈不上佩服'],
    ['face-saving', '顾及脸面', 'Face saving', S.own, 'mid', 'any', 'estimated', '肯定与尊重', '有分歧也不点破'],
    // ---- 支持与依靠
    ['small-favors', '顺水人情', 'Small favors', S.own, 'mid', 'any', 'estimated', '支持与依靠', '帮得上就帮，不算欠情'],
    ['not-counted-on', '不抱期待', 'Not counted on', S.own, 'mid', 'any', 'estimated', '支持与依靠', '有事不会先想到对方'],
    // ---- 信任与坦白
    ['half-trusting', '半信半疑', 'Half trusting', S.own, 'mid', 'any', 'estimated', '信任与坦白', '信一半，留一半'],
    ['watchful', '观望', 'Watchful', S.own, 'mid', 'any', 'estimated', '信任与坦白', '还没定论，看对方怎么做'],
    ['measured-candor', '有所保留', 'Measured candor', S.own, 'mid', 'any', 'estimated', '信任与坦白', '真话不全说，假话不说'],
    // ---- 稳定与承诺
    ['ambiguous', '若即若离', 'Ambiguous', S.own, 'mid', 'any', 'estimated', '稳定与承诺', '忽近忽远，摸不准'],
    ['unsettled', '悬而未决', 'Unsettled', S.own, 'mid', 'any', 'estimated', '稳定与承诺', '还没个说法'],
    ['off-and-on', '时好时坏', 'Off and on', S.own, 'mid', 'any', 'estimated', '稳定与承诺', '一阵近一阵远，说不准'],
    // ---- 冲突与攻击
    ['occasional-friction', '偶有摩擦', 'Occasional friction', S.own, 'mid', 'any', 'estimated', '冲突与攻击', '不常吵，但会硌一下'],
    ['surface-harmony', '面和心不和', 'Surface harmony', S.own, 'mid', 'any', 'estimated', '冲突与攻击', '面子过得去，心里不近'],
    // ---- 权力与支配
    ['business-like', '公事公办', 'Business-like', S.own, 'mid', 'any', 'estimated', '权力与支配', '只谈事，不谈情'],
    ['separate-turf', '各司其职', 'Separate turf', S.own, 'mid', 'any', 'estimated', '权力与支配', '各有各的范围，互不插手'],
    ['parity', '平级相处', 'Parity', S.own, 'mid', 'even', 'estimated', '权力与支配', '地位相当，客气而平等'],
    ['senior-junior', '有主有次', 'Senior & junior', S.own, 'mid', 'asymmetric', 'estimated', '权力与支配', '一个安排，一个配合'],
    ['following-lead', '听候安排', 'Following lead', S.own, 'mid', 'asymmetric', 'estimated', '权力与支配', '跟着对方的节奏走'],
    // ---- 冷待与排斥
    ['cool-but-polite', '冷淡但客气', 'Cool but polite', S.own, 'mid', 'any', 'estimated', '冷待与排斥', '不热乎，但不得罪'],
    ['noncommittal', '不咸不淡', 'Noncommittal', S.own, 'mid', 'any', 'estimated', '冷待与排斥', '回应着，但不接话头'],
    // ---- 互惠与付出
    ['tit-for-tat', '礼尚往来', 'Tit for tat', S.own, 'mid', 'any', 'estimated', '互惠与付出', '你送我我送你，有来有往'],
    ['even-score', '两不相欠', 'Even score', S.own, 'mid', 'any', 'estimated', '互惠与付出', '谁也不欠谁，算得清'],
    ['lopsided', '付出不对等', 'Lopsided', S.own, 'mid', 'asymmetric', 'estimated', '互惠与付出', '一方付出多，一方接受多'],
    // ---- 依赖与自主
    ['independent', '互不干涉', 'Independent', S.own, 'mid', 'any', 'estimated', '依赖与自主', '各自独立，互不打扰'],
    // ---- 安心与消耗
    ['neutral-comfort', '不累也不亲', 'Neutral comfort', S.own, 'mid', 'any', 'estimated', '安心与消耗', '相处不费劲，也不亲近'],
    ['provisional', '未交底', 'Provisional', S.own, 'mid', 'any', 'estimated', '安心与消耗', '都留着后手，没放开'],
  ].map(([id, zh, en, source, closeness, agency, termProvenance, facet, meaning]) => Object.freeze({
    id, zh, en, source, closeness, agency, termProvenance, facet, meaning,
    mappingProvenance: 'estimated',
    note: termProvenance === 'literature'
      ? '词与出处为已核实的中文量表维度名；归到哪一档是本项目的映射。'
      : '本项目整理的说法，无单一文献出处；归到哪一档是本项目的映射。',
  })),

  // ============================================================ 亲近度低 · low
  ...[
    // ---- 冲突与攻击
    ['conflict-betrayal', '冲突与背叛', 'Conflict & betrayal', S.friend6, 'low', 'any', 'literature', '冲突与攻击', '吵架，还有出卖和失信'],
    ['conflict-betrayal5', '冲突背叛', 'Conflict & betrayal', S.friend5, 'low', 'any', 'literature', '冲突与攻击', '常起冲突，也可能被辜负'],
    ['conflictiveness', '冲突性', 'Conflictiveness', S.teacher, 'low', 'any', 'literature', '冲突与攻击', '容易争执，话里带火'],
    ['hostility', '敌意', 'Hostility', S.friendCommon, 'low', 'any', 'literature', '冲突与攻击', '看对方不顺眼，带攻击性'],
    ['family-conflict', '矛盾性', 'Family conflict', S.family, 'low', 'any', 'literature', '冲突与攻击', '当着面互相拆台'],
    ['conflict', '冲突', 'Conflict', S.nri, 'low', 'any', 'literature', '冲突与攻击', '争执、拌嘴、闹脾气'],
    ['antagonism', '对抗', 'Antagonism', S.nri, 'low', 'any', 'literature', '冲突与攻击', '互相惹火、彼此烦'],
    ['friction', '摩擦', 'Friction', S.own, 'low', 'any', 'estimated', '冲突与攻击', '小冲突不断'],
    ['tense', '紧张', 'Tense', S.own, 'low', 'any', 'estimated', '冲突与攻击', '一说话就绷着'],
    ['frozen', '僵住', 'Frozen', S.own, 'low', 'any', 'estimated', '冲突与攻击', '话停了，谁也不先动'],
    ['awkward', '别扭', 'Awkward', S.own, 'low', 'any', 'estimated', '冲突与攻击', '相处不自在，卡着'],
    ['cold-war', '冷战', 'Cold war', S.own, 'low', 'any', 'estimated', '冲突与攻击', '不说话，也不和解'],
    ['resentful', '积怨', 'Resentful', S.own, 'low', 'any', 'estimated', '冲突与攻击', '不吵了，但账都记着'],
    ['stalemate', '僵持', 'Stalemate', S.own, 'low', 'even', 'estimated', '冲突与攻击', '谁也不退，顶着'],
    ['head-on', '针锋相对', 'Head-on', S.own, 'low', 'even', 'estimated', '冲突与攻击', '正面顶，谁也不让'],
    ['standoff', '对峙', 'Standoff', S.own, 'low', 'even', 'estimated', '冲突与攻击', '各站一边，互相盯着'],
    ['eating-bitterness', '隐忍', 'Eating bitterness', S.own, 'low', 'asymmetric', 'estimated', '冲突与攻击', '你受了也不说，憋着'],
    ['swallowing-anger', '敢怒不敢言', 'Swallowing anger', S.own, 'low', 'asymmetric', 'estimated', '冲突与攻击', '你不满但不敢说'],
    ['bullied', '受制', 'Being controlled', S.own, 'low', 'asymmetric', 'estimated', '冲突与攻击', '被他攥着，没主动权'],
    ['appeasing', '讨好', 'Appeasing', S.own, 'low', 'asymmetric', 'estimated', '冲突与攻击', '怕他不高兴，主动示好'],
    // ---- 冷待与排斥
    ['exclusion', '排斥', 'Exclusion', S.nriRqv, 'low', 'any', 'literature', '冷待与排斥', '把对方拦在外面，不带他玩'],
    ['distant', '疏远', 'Distant', S.own, 'low', 'any', 'estimated', '冷待与排斥', '距离拉开，来往变少'],
    ['unfamiliar', '生疏', 'Unfamiliar', S.own, 'low', 'any', 'estimated', '冷待与排斥', '从熟变回不熟'],
    ['standoffish', '见外', 'Standoffish', S.own, 'low', 'any', 'estimated', '冷待与排斥', '该亲近却客套'],
    ['barrier', '隔膜', 'Barrier', S.own, 'low', 'any', 'estimated', '冷待与排斥', '有话说不到一块儿'],
    ['cold', '冷淡', 'Cold', S.own, 'low', 'any', 'estimated', '冷待与排斥', '不热情、不上心'],
    ['indifferent', '漠不关心', 'Indifferent', S.own, 'low', 'any', 'estimated', '冷待与排斥', '对方的事与我无关'],
    ['perfunctory', '敷衍', 'Perfunctory', S.own, 'low', 'any', 'estimated', '冷待与排斥', '嘴上应着，实际不当事'],
    ['disengaged', '无心理会', 'Disengaged', S.own, 'low', 'any', 'estimated', '冷待与排斥', '对方的事懒得管'],
    ['avoided', '被回避', 'Avoided', S.own, 'low', 'asymmetric', 'estimated', '冷待与排斥', '他躲着你'],
    // ---- 信任与坦白
    ['distrust', '不信任', 'Distrust', S.trust, 'low', 'any', 'literature', '信任与坦白', '提防对方，不敢交底'],
    ['suspicion', '猜忌', 'Suspicion', S.own, 'low', 'any', 'estimated', '信任与坦白', '怀疑对方的动机'],
    ['guarded', '防备', 'Guarded', S.own, 'low', 'any', 'estimated', '信任与坦白', '留一手，不说实话'],
    ['hiding', '隐瞒', 'Hiding', S.own, 'low', 'any', 'estimated', '信任与坦白', '有事情不说，瞒着'],
    // ---- 交心深度
    ['depth-low', '关系浅', 'Low depth', S.qri, 'low', 'any', 'literature', '交心深度', '牵连少，可有可无'],
    ['no-confiding', '不交心', 'No confiding', S.own, 'low', 'any', 'estimated', '交心深度', '说不到心里去'],
    // ---- 支持与依靠
    ['unsupported', '无可依靠', 'Unsupported', S.own, 'low', 'any', 'estimated', '支持与依靠', '需要时对方不在'],
    // ---- 权力与支配
    ['relative-power', '相对权力', 'Relative power', S.nri, 'low', 'asymmetric', 'literature', '权力与支配', '谁更能支配谁'],
    ['dominance', '支配', 'Dominance', S.nriRqv, 'low', 'asymmetric', 'literature', '权力与支配', '一方压着另一方走'],
    ['control', '控制', 'Control', S.qri, 'low', 'asymmetric', 'literature', '权力与支配', '一方盯着、管着另一方'],
    ['harsh-interference', '苛责', 'Harshness', S.parent, 'low', 'asymmetric', 'literature', '权力与支配', '你老挑他毛病、管得宽'],
    ['criticism', '挑剔', 'Criticism', S.nriRqv, 'low', 'asymmetric', 'literature', '权力与支配', '你只说他不足、专挑错'],
    ['pressure', '压制', 'Pressure', S.nriRqv, 'low', 'asymmetric', 'literature', '权力与支配', '你让他喘不过气'],
    ['one-leads-one-follows', '一方拿主意、一方听', 'One leads', S.own, 'low', 'asymmetric', 'estimated', '权力与支配', '一个人定，另一个人照办'],
    ['deferring', '察言观色', 'Deferring', S.own, 'low', 'asymmetric', 'estimated', '权力与支配', '得揣摩他高不高兴'],
    ['equal-footing', '对等', 'Equal footing', S.own, 'low', 'even', 'estimated', '权力与支配', '分量相当，谁也不压谁'],
    ['evenly-matched', '势均力敌', 'Evenly matched', S.own, 'low', 'even', 'estimated', '权力与支配', '实力相当，顶得住对方'],
    ['mutual-guard', '互相提防', 'Mutual guard', S.own, 'low', 'even', 'estimated', '权力与支配', '谁也不放心谁'],
    ['no-yielding', '互不相让', 'No yielding', S.own, 'low', 'even', 'estimated', '权力与支配', '各执一词，都不退'],
    // ---- 互惠与付出
    ['exploited', '被索取', 'Exploited', S.own, 'low', 'asymmetric', 'estimated', '互惠与付出', '他一直拿，你一直给'],
    ['exploitative', '索取', 'Exploitative', S.own, 'low', 'asymmetric', 'estimated', '互惠与付出', '你只想要，不想给'],
    ['owing', '亏欠', 'Owing', S.own, 'low', 'asymmetric', 'estimated', '互惠与付出', '两边有一笔没算清的账'],
    // ---- 依赖与自主
    ['clinging-conflict', '纠缠', 'Clinging conflict', S.own, 'low', 'any', 'estimated', '依赖与自主', '分不开也处不好'],
    ['enmeshed', '牵扯不清', 'Enmeshed', S.own, 'low', 'any', 'estimated', '依赖与自主', '分不清谁的事，搅在一起'],
    ['cut-off', '断绝', 'Cut off', S.own, 'low', 'any', 'estimated', '依赖与自主', '各断各的，不再牵扯'],
    // ---- 安心与消耗
    ['draining', '彼此消耗', 'Draining', S.own, 'low', 'any', 'estimated', '安心与消耗', '相处之后更累'],
    ['on-eggshells', '如履薄冰', 'On eggshells', S.own, 'low', 'any', 'estimated', '安心与消耗', '小心翼翼，怕说错话'],
    ['anxious-attachment', '患得患失', 'Anxious', S.own, 'low', 'any', 'estimated', '安心与消耗', '怕失去，反复揣摩'],
    ['resigned', '听天由命', 'Resigned', S.own, 'low', 'any', 'estimated', '安心与消耗', '不指望变好，就这样'],
    // ---- 稳定与承诺
    ['unstable', '不稳定', 'Unstable', S.own, 'low', 'any', 'estimated', '稳定与承诺', '时好时坏，说不准'],
  ].map(([id, zh, en, source, closeness, agency, termProvenance, facet, meaning]) => Object.freeze({
    id, zh, en, source, closeness, agency, termProvenance, facet, meaning,
    mappingProvenance: 'estimated',
    note: termProvenance === 'literature'
      ? '词与出处为已核实的中文量表维度名；归到哪一档是本项目的映射。'
      : '本项目整理的说法，无单一文献出处；归到哪一档是本项目的映射。',
  })),

  // ============================================ 与亲近度无关 · any（只看主导性）
  ...[
    ['on-equal-footing', '平起平坐', 'Equal standing', S.own, 'any', 'even', 'estimated', '权力与支配', '地位相当，谁也不高一头'],
    ['give-and-take', '有商有量', 'Give and take', S.own, 'any', 'even', 'estimated', '权力与支配', '事情一起定，不做单方决定'],
    ['mutual-consent', '彼此自主', 'Mutual autonomy', S.own, 'any', 'even', 'estimated', '权力与支配', '各管自己，不去指挥对方'],
    ['swapping-roles', '轮流做主', 'Swapping roles', S.own, 'any', 'even', 'estimated', '权力与支配', '这次听你的，下次听我的'],
    ['protective-dominance', '一手包办', 'Protective control', S.own, 'any', 'asymmetric', 'estimated', '权力与支配', '你替他做决定，自认是为他好'],
    ['leading', '做主', 'Leading', S.own, 'any', 'asymmetric', 'estimated', '权力与支配', '事情最终由你定'],
    ['trailing', '跟随', 'Trailing', S.own, 'any', 'asymmetric', 'estimated', '权力与支配', '你不争方向，跟着他'],
    ['relying-on-other', '仰仗', 'Relying on', S.own, 'any', 'asymmetric', 'estimated', '依赖与自主', '很多事靠他才有底气'],
    ['needed-by-other', '被仰仗', 'Needed by', S.own, 'any', 'asymmetric', 'estimated', '依赖与自主', '他很多事要靠你'],
  ].map(([id, zh, en, source, closeness, agency, termProvenance, facet, meaning]) => Object.freeze({
    id, zh, en, source, closeness, agency, termProvenance, facet, meaning,
    mappingProvenance: 'estimated',
    note: termProvenance === 'literature'
      ? '词与出处为已核实量表；归到哪一档是本项目的映射。'
      : '本项目整理的说法，无单一文献出处；归到哪一档是本项目的映射。',
  })),

  // ================================================== 单向词的镜像（谁对谁）
  //
  // ⚠️ 这一节存在的理由是一个真 bug：选词原先只看 `|a_self − a_other|`，**方向被丢掉了**，
  // 于是「角色宠着用户」和「用户宠着角色」选出同一批词，谁对谁全靠「表里谁排前面」蒙。
  // 修法是把单向词写成**词形自带主语**的两半（`宠着他` / `被他宠着`），再按带符号的差挑。
  // 好处是这些词读起来就是一个短语，界面上不需要再拼主谓宾。
  ...[
    // ---- 高亲近 + 用户主导（角色是被照顾的那一方）
    ['spoiled-by', '被宠爱', 'Spoiled by', S.own, 'high', 'asymmetric', 'estimated', '关心与温度', '他愿意惯着你、让着你'],
    ['protected-by', '被保护', 'Protected by', S.own, 'high', 'asymmetric', 'estimated', '关心与温度', '有事他会替你挡'],
    ['guided-by', '受指导', 'Guided by', S.own, 'high', 'asymmetric', 'estimated', '支持与依靠', '他教你、帮你办成事'],
    // ---- 低亲近 + 用户主导
    ['harshly-treated', '被苛责', 'Harshly treated', S.own, 'low', 'asymmetric', 'estimated', '权力与支配', '他老挑你毛病、管得宽'],
    ['criticized-by', '被挑剔', 'Criticized by', S.own, 'low', 'asymmetric', 'estimated', '权力与支配', '他只说你的不足'],
    ['pressed-by', '被压制', 'Pressed by', S.own, 'low', 'asymmetric', 'estimated', '权力与支配', '他让你喘不过气'],
    // ---- 与亲近度无关 + 用户主导
    ['managed-by', '被管束', 'Managed by', S.own, 'any', 'asymmetric', 'estimated', '权力与支配', '他替你拿主意，说为你好'],
  ].map(([id, zh, en, source, closeness, agency, termProvenance, facet, meaning]) => Object.freeze({
    id, zh, en, source, closeness, agency, termProvenance, facet, meaning,
    mappingProvenance: 'estimated',
    note: `本项目整理的说法，无单一文献出处；归到哪一档是本项目的映射。`,
  })),
]);

/**
 * 每个词的**方向**。不在表里的按 `'both'`（对称）处理。
 *
 * - `'self'`：**角色**是施动/主导的一方，词形已写明（`宠着他`、`你说了算`）。
 * - `'other'`：**用户**是施动/主导的一方，词形已写明（`被他宠着`、`听他的`）。
 *
 * 测试里有一条护栏：凡是词形自带主语（`他…你`、`被他…`、`X他`）的单向词，都必须在这张表里——
 * 漏一个就会退回方向靠蒙的状态。
 * @type {Readonly<Record<string, 'self'|'other'>>}
 */
const DIRECTION = Object.freeze({
  // 角色是施动方
  spoiling: 'self',
  protective: 'self',
  'help-guidance': 'self',
  'leaned-on': 'self',
  'harsh-interference': 'self',
  criticism: 'self',
  pressure: 'self',
  exploitative: 'self',
  'protective-dominance': 'self',
  leading: 'self',
  'needed-by-other': 'self',
  // 用户是施动方
  'spoiled-by': 'other',
  'protected-by': 'other',
  'guided-by': 'other',
  reliant: 'other',
  'harshly-treated': 'other',
  'criticized-by': 'other',
  'pressed-by': 'other',
  'managed-by': 'other',
  trailing: 'other',
  bullied: 'other',
  appeasing: 'other',
  deferring: 'other',
  avoided: 'other',
  'eating-bitterness': 'other',
  'swallowing-anger': 'other',
  exploited: 'other',
  'relying-on-other': 'other',
  // 「听安排」的解释是「跟着对方的节奏走」——单向，方向在用户那一侧。
  // 原先漏登记（默认成了 both），于是角色主导时也会冒出「听安排」，意思是反的。
  'following-lead': 'other',
});

/**
 * 方向表本体，导出给自检用。
 *
 * 需要它是因为「登记了一个不存在的 id」这种悬空条目，只导出 `directionOf` 是查不出来的
 * ——查不到的 id 一律返回默认的 `both`，表面上看不出任何异常。
 */
export const DIRECTIONS = DIRECTION;

/**
 * 取某个词的方向。
 * @param {object} state 词条。
 * @returns {'both'|'self'|'other'} 方向。
 */
export function directionOf(state) {
  return DIRECTION[state.id] ?? 'both';
}

/**
 * 每个维度对应的一句**具体做法**。
 *
 * ## 为什么要有这个
 *
 * 改之前，「行为指引」是按**结构类型**（互补/对立/错位/相似）给一句固定的话，而那四个
 * 类型里 66% 都是「互补」，所以实测 58 轮真实打分里最常见的两种指引覆盖了 71%，
 * 还有 47% 干脆是「很平淡，不必渲染关系」这种空信号。也就是说：状态词每轮都在变，
 * 却完全没被用来生成建议——这一层就是补上这个缺口。
 *
 * 键的取法（不是所有键都得有）：
 * - `self` / `other` / `both`：**方向**敏感的词（权力与支配、依赖与自主）用方向选，
 *   因为「你在拿主意」和「对方在拿主意」该给的建议正好相反。
 * - `pos` / `neg`：其余维度按词的极性选（亲近度 `low` 算 neg，否则 pos）。
 *
 * 写法要求：**祈使句、说具体动作**，不要重复维度名，也不要复述数字。
 * @type {Readonly<Record<string, Readonly<Record<string,string>>>>}
 */
export const FACET_HINTS = Object.freeze({
  交心深度: Object.freeze({
    pos: '可以多说点自己的判断和感受，不用只报结论',
    neg: '先别交底，把话说在事情上',
  }),
  关心与温度: Object.freeze({
    pos: '语气上带点关心，问一句对方的处境',
    neg: '别硬凑热乎，公事公办就行',
  }),
  共同活动: Object.freeze({
    pos: '顺着他起的话题往下走，多接一句',
    neg: '不用主动找话题，把话说完就停',
  }),
  肯定与尊重: Object.freeze({
    pos: '认可对方说得对的地方，具体点出来',
    neg: '有不同意见直接说，别用「你说得对」敷衍',
  }),
  支持与依靠: Object.freeze({
    pos: '给出能落地的帮助，别只表态',
    neg: '别把担子都接下来，先说清你能做什么',
  }),
  信任与坦白: Object.freeze({
    pos: '该说的都说，不用留后手',
    neg: '不确定的地方问一句，别替对方假设',
  }),
  稳定与承诺: Object.freeze({
    pos: '把长期打算说出来，让对方知道你要往哪走',
    neg: '别给长期承诺，先把这一轮说清楚',
  }),
  冲突与攻击: Object.freeze({
    pos: '有分歧就事论事，别翻旧账',
    neg: '先降温——把话说短，只谈这一件事',
  }),
  权力与支配: Object.freeze({
    self: '你在拿主意，把理由说清楚，也留出对方回话的余地',
    other: '现在是对方定方向，先确认再执行，别替他决定',
    both: '按平级的分寸来，事情一起定，不做单方决定',
  }),
  冷待与排斥: Object.freeze({
    neg: '别装热络，礼貌但收着，不主动递话',
    pos: '不用刻意热络，保持现在的分寸就好',
  }),
  距离与分寸: Object.freeze({
    pos: '按熟人的分寸来，私事可以聊两句',
    neg: '保持礼貌距离，不越界、不问私事',
  }),
  互惠与付出: Object.freeze({
    pos: '有来有往，接下对方的好意也回一份',
    neg: '留意是不是一边倒，该说不就说',
  }),
  依赖与自主: Object.freeze({
    // 措辞刻意留成条件句：这里测到的是**主导性差**，不是「谁依赖谁」。
    // 状态词那层可以把它读成依赖，但建议不该把一个没测过的东西说成事实。
    self: '对方更靠你时，接住，但别替他做完所有事',
    other: '你更靠对方时，把需要说出口，别硬撑着',
    both: '各管各的，不用把对方的事揽过来',
  }),
  安心与消耗: Object.freeze({
    pos: '可以放松一点，不必每句都防着',
    neg: '先降低压迫感——短句、少评价、别下判断',
  }),
});

/**
 * 中间档（`mid`）每个词的**极性**：这个说法是偏「有」还是偏「没有」。
 *
 * 为什么不能从档位推：`mid` 里既有「熟人」这种偏正面的，也有「有保留」「只谈表面」
 * 这种明显偏负面的。早先按 `closeness === 'low'` 判极性，于是「有保留」拿到了正向那句
 * 「可以多说点自己的判断和感受」——**正好说反**。所以这里逐个点明。
 *
 * 高/低档不用列：高一律正向、低一律负向。`any` 档也不用列（它们靠方向选建议）。
 * 测试里有一条护栏：每个 `mid` 词都必须在这张表里，漏一个就红。
 * @type {Readonly<Record<string,'pos'|'neg'>>}
 */
const MID_POLARITY = Object.freeze({
  // 偏正面
  acquaintance: 'pos',
  'with-boundaries': 'pos',
  'occasional-meet': 'pos',
  'tit-for-tat': 'pos',
  'even-score': 'pos',
  // 偏负面（这一批是「有形式没内容」或「没定下来」）
  polite: 'neg',
  'nodding-acquaintance': 'neg',
  'casual-acquaintance': 'neg',
  'half-familiar': 'neg',
  'colleague-like': 'neg',
  'average-relationship': 'neg',
  'maintain-distance': 'neg',
  'separate-lives': 'neg',
  seasonal: 'neg',
  reserved: 'neg',
  'surface-only': 'neg',
  'partial-open': 'neg',
  lukewarm: 'neg',
  'polite-concern': 'neg',
  'formal-civility': 'neg',
  'measured-warmth': 'neg',
  'contact-when-needed': 'neg',
  'functional-tie': 'neg',
  'courteous-regard': 'neg',
  'face-saving': 'neg',
  'small-favors': 'neg',
  'not-counted-on': 'neg',
  'half-trusting': 'neg',
  watchful: 'neg',
  'measured-candor': 'neg',
  ambiguous: 'neg',
  unsettled: 'neg',
  'off-and-on': 'neg',
  'occasional-friction': 'neg',
  'surface-harmony': 'neg',
  'business-like': 'neg',
  'separate-turf': 'neg',
  'cool-but-polite': 'neg',
  noncommittal: 'neg',
  lopsided: 'neg',
  'neutral-comfort': 'neg',
  provisional: 'neg',
});

/**
 * 取某个词对应的具体做法。
 *
 * ⚠️ 方向参数**优先于词自己的方向**，这一点是被实测逼出来的：像「有主有次」这种词
 * 本身不带方向（它只说「一个安排一个配合」，没说谁在上面），如果按词自己的方向取，
 * 会取到 `both` 那句「按平级的分寸来」——而实际状态是**用户主导**，正好说反。
 * 所以方向一律以**这段关系的方向**为准。
 * @param {object} word 选中的状态词（需要 `id` / `facet` / `closeness`）。
 * @param {'self'|'other'|'both'} [direction] 当前这段关系的方向；省略时才退回词自己的方向。
 * @returns {string} 一句祈使句，或空串（该维度还没写）。
 */
export function hintFor(word, direction) {
  const table = FACET_HINTS[word?.facet];
  if (table === undefined) return '';
  const dir = direction ?? word.direction ?? directionOf(word);
  if (dir !== 'both' && typeof table[dir] === 'string') return table[dir];
  if (dir === 'both' && typeof table.both === 'string') return table.both;
  const polarity = word.closeness === 'low'
    ? 'neg'
    : (MID_POLARITY[word.id] ?? 'pos');
  return table[polarity] ?? table.pos ?? table.neg ?? '';
}

/**
 * 中间档极性表，导出给自检用（每个 `mid` 词都必须登记）。
 * @returns {Readonly<Record<string,'pos'|'neg'>>} 极性表。
 */
export function midPolarity() {
  return MID_POLARITY;
}


/** 亲近度档的分界：均值 ≥ 高线算高、≤ 低线算低，中间是中。 */
const CLOSENESS_HIGH = 0.6;
const CLOSENESS_LOW = 0.4;
/** 双方主导性之差的绝对值达到这个值，就算「一方明显拿主意」。 */
const AGENCY_GAP = 0.3;
/**
 * 比较阈值时用的容差。
 *
 * ⚠️ 这不是「差不多就行」，是修一个真实的边界 bug：格子是 0.1 量化的，所以差**正好** 0.3
 * （比如 0.4 与 0.7）是很常见的取值，但浮点里 `0.4 - 0.7 = -0.29999999999999993`，
 * 于是 `Math.abs(...) < 0.3` 成立——**恰好差 0.3 的一对被判成「两人相当」**，
 * 单向词一个都不给。实测过：角色 0.4 / 用户 0.7 本该走「用户主导」，却给出「并肩」
 * 这种与方向无关的词。加容差后边界归到正确的一侧。
 */
const EPS = 1e-9;
/**
 * 「与某一档无关」的那些词的匹配度折扣。
 *
 * 取 0.8 而不是 1：像「平起平坐」这类词本来就与亲近度无关。给满分会让它们在任何
 * 状态下都压过真正对上的词；0.8 让它们稳定出现、但排在明确命中的词后面。
 */
const NEUTRAL_MATCH = 0.8;
/** 低于这个匹配度的词不返回（两个维度都不沾边的词是 0.64）。 */
const MIN_SCORE = 0.6;

/**
 * 把当前读数翻译成关系状态词，按「有多贴」排序、并按维度去重。
 *
 * ## 三件事决定一个词能不能上场
 *
 * 1. **亲近度档**：词要么正好属于当前这一档，要么与亲近度无关（`any`）。
 * 2. **主导性**：词要么要求「一方明显拿主意」而确实如此，要么要求「两人相当」而确实如此，
 *    要么与主导性无关（`any`）。
 * 3. **方向**：带主语的单向词只在**它指的那一方**确实主导时才上场——
 *    角色主导才说 `宠着`，用户主导才说 `被宠着`。
 *
 * ⚠️ 第 3 条是修一个真 bug。原先只看 `|a_self − a_other|`，**方向被丢掉了**，
 * 于是「角色宠着用户」和「用户宠着角色」选出同一批词，谁对谁全靠「表里谁排前面」蒙——
 * 甚至同一个列表里会同时出现「占便宜」和「被占便宜」这种互斥的说法。
 * 现在改成看**带符号**的差：`a_self − a_other` 为正走 `self` 那一半，为负走 `other` 那一半。
 *
 * 匹配度只用来排序与画条：正好对上两档是 `1.0`，有一档是 `any` 是 `0.8`，两档都 `any` 是 `0.64`。
 * @param {object} metrics {@link import('./circumplex.js').relationship} 的结果。
 * @param {object} [options] 选项。
 * @param {number} [options.limit=6] 最多返回几个词。
 * @param {number} [options.minScore=0.6] 低于这个匹配度的不返回。
 * @param {number} [options.maxPerFacet=1] 同一维度最多取几个（默认 1，保证横跨不同维度）。
 * @returns {{closeness:'high'|'mid'|'low', agency:'asymmetric'|'even', direction:'self'|'other'|'both',
 *   meanCloseness:number, agencyGap:number, words:Array<object>}} 选中的词（降序，带 `score`/`facet`/`direction`）。
 */
export function relationshipStates(metrics, options = {}) {
  const limit = options.limit ?? 6;
  const minScore = options.minScore ?? MIN_SCORE;
  const maxPerFacet = options.maxPerFacet ?? 1;
  const meanCloseness = (metrics.self.c + metrics.other.c) / 2;
  const closeness = meanCloseness >= CLOSENESS_HIGH - EPS
    ? 'high'
    : meanCloseness <= CLOSENESS_LOW + EPS ? 'low' : 'mid';

  // ⚠️ 带符号的差：正数代表角色更主导。取绝对值就会丢掉「谁对谁」，那是原来的 bug。
  const signedGap = metrics.self.a - metrics.other.a;
  const agencyGap = Math.abs(signedGap);
  const agency = agencyGap >= AGENCY_GAP - EPS ? 'asymmetric' : 'even';
  const direction = agency !== 'asymmetric' ? 'both' : (signedGap > 0 ? 'self' : 'other');

  // ⚠️ 两人都在中心时**不给任何词**：那是「还谈不上」，不是某种关系。
  // 这一条是被实测抓出来的（全新会话曾被说成「关系深」）。
  if (metrics.flat === true) {
    return { closeness, agency, direction, meanCloseness, agencyGap, words: [] };
  }

  const scored = STATES
    .filter((state) => state.closeness === 'any' || state.closeness === closeness)
    .filter((state) => state.agency === 'any' || state.agency === agency)
    .filter((state) => {
      const wordDirection = directionOf(state);
      return wordDirection === 'both' || wordDirection === direction;
    })
    .map((state) => ({
      ...state,
      direction: directionOf(state),
      score: (state.closeness === 'any' ? NEUTRAL_MATCH : 1)
        * (state.agency === 'any' ? NEUTRAL_MATCH : 1),
    }))
    .filter((state) => state.score >= minScore)
    // 同分时：先给正好对上那一档的词，再按表内顺序（sort 稳定）
    .sort((left, right) => (right.score - left.score)
      || ((left.closeness === 'any' ? 1 : 0) - (right.closeness === 'any' ? 1 : 0)));

  // 同一个维度最多取 `maxPerFacet` 个——否则前六名会是一串近义说法。
  const perFacet = new Map();
  const picked = [];
  for (const word of scored) {
    const used = perFacet.get(word.facet) ?? 0;
    if (used >= maxPerFacet) continue;
    perFacet.set(word.facet, used + 1);
    picked.push(word);
    if (picked.length >= Math.max(0, limit)) break;
  }

  return { closeness, agency, direction, meanCloseness, agencyGap, words: picked };
}

/**
 * 列出整张词表，供工具与自检展示。
 * @returns {object[]} 词表副本。
 */
export function stateCatalog() {
  return STATES.map((state) => ({
    id: state.id,
    zh: state.zh,
    en: state.en,
    meaning: state.meaning,
    closeness: state.closeness,
    agency: state.agency,
    facet: state.facet,
    termProvenance: state.termProvenance,
    mappingProvenance: state.mappingProvenance,
    scale: state.source.scale,
    ref: state.source.ref,
    note: state.note,
  }));
}

/**
 * 词表统计，供工具输出与自检用。
 * @returns {{total:number, literature:number, own:number, sources:number, facets:number,
 *   high:number, mid:number, low:number, anyCloseness:number,
 *   asymmetric:number, even:number, anyAgency:number}} 统计。
 */
export function stateStats() {
  return {
    total: STATES.length,
    literature: STATES.filter((state) => state.termProvenance === 'literature').length,
    own: STATES.filter((state) => state.termProvenance === 'estimated').length,
    sources: new Set(STATES.map((state) => state.source.scale)).size,
    facets: new Set(STATES.map((state) => state.facet)).size,
    high: STATES.filter((state) => state.closeness === 'high').length,
    mid: STATES.filter((state) => state.closeness === 'mid').length,
    low: STATES.filter((state) => state.closeness === 'low').length,
    anyCloseness: STATES.filter((state) => state.closeness === 'any').length,
    asymmetric: STATES.filter((state) => state.agency === 'asymmetric').length,
    even: STATES.filter((state) => state.agency === 'even').length,
    anyAgency: STATES.filter((state) => state.agency === 'any').length,
  };
}
