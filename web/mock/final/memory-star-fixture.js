// Accessed only through an explicitly selected, local fixture.
const synthetic = {
    nodes: [
      { id: 'memory:m1', type: 'memory', label: '海边散步', summary: '喜欢傍晚沿海边散步，风大时会走防波堤内侧。', occurredAt: 1794920400, recordedAt: 1795006900, source: '合成样例', status: 'active' },
      { id: 'traffic:quiet', type: 'traffic', label: '安静时段', status: 'active' },
      { id: 'traffic:coast', type: 'traffic', label: '海边', status: 'active' },
      { id: 'memory:m2', type: 'memory', label: '周末去看海', summary: '周末有空时想去海边走走。', occurredAt: null, recordedAt: 1794751000, source: '合成样例', status: 'active' },
      { id: 'memory:m3', type: 'memory', label: '安静的餐厅', summary: '选餐厅时更喜欢安静、能好好聊天的地方。', occurredAt: null, recordedAt: 1794300100, source: '合成样例', status: 'active' },
      { id: 'traffic:food', type: 'traffic', label: '餐厅选择', status: 'active' },
      { id: 'memory:m4', type: 'memory', label: '看海前吃饭', summary: null, occurredAt: null, recordedAt: null, source: '合成样例', status: 'active' },
      { id: 'traffic:walk', type: 'traffic', label: '散步习惯', status: 'active' },
      { id: 'memory:m5', type: 'memory', label: '沿湖慢跑', summary: '天气舒服时会沿湖慢跑一小段。', occurredAt: null, recordedAt: 1794000000, source: '合成样例', status: 'active' },
      { id: 'traffic:water', type: 'traffic', label: '水边活动', status: 'active' },
      { id: 'memory:m6', type: 'memory', label: '雨天改室内', summary: '下雨天会把散步改成室内拉伸。', occurredAt: null, recordedAt: 1793600000, source: '合成样例', status: 'active' },
      { id: 'traffic:stretch', type: 'traffic', label: '舒缓运动', status: 'active' },
      { id: 'memory:m7', type: 'memory', label: '周末早起', summary: '周末早上自然醒时喜欢先泡茶。', occurredAt: null, recordedAt: 1793200000, source: '合成样例', status: 'active' },
      { id: 'traffic:weekend', type: 'traffic', label: '周末节奏', status: 'active' },
      { id: 'memory:m8', type: 'memory', label: '带相机看海', summary: '想带小相机去海边拍云和潮汐。', occurredAt: null, recordedAt: 1792800000, source: '合成样例', status: 'active' }
    ],
    edges: [
      { id: 'fixture-edge-a', source: 'memory:m1', target: 'traffic:quiet', kind: 'memory-link', relation: '偏好安静', evidenceStatus: 'verified', evidence: '合成回执示例' },
      { id: 'fixture-edge-b', source: 'memory:m1', target: 'traffic:coast', kind: 'memory-link', relation: '散步地点', evidenceStatus: 'verified', evidence: '合成回执示例' },
      { id: 'fixture-edge-c', source: 'traffic:quiet', target: 'traffic:food', kind: 'traffic-link', relation: '影响选择', evidenceStatus: 'missing', evidence: '未记录可验证回执' },
      { id: 'fixture-edge-d', source: 'memory:m2', target: 'traffic:coast', kind: 'memory-link', relation: '计划地点', evidenceStatus: 'verified', evidence: '合成回执示例' },
      { id: 'fixture-edge-e', source: 'memory:m3', target: 'traffic:quiet', kind: 'memory-link', relation: '环境偏好', evidenceStatus: 'verified', evidence: '合成回执示例' },
      { id: 'fixture-edge-f', source: 'traffic:food', target: 'traffic:coast', kind: 'traffic-link', relation: '出行安排', evidenceStatus: 'verified', evidence: '合成回执示例' },
      { id: 'fixture-edge-g', source: 'memory:m4', target: 'traffic:food', kind: 'memory-link', relation: '出行安排', evidenceStatus: 'missing', evidence: '未记录可验证回执' },
      { id: 'fixture-edge-h', source: 'memory:m5', target: 'traffic:walk', kind: 'memory-link', relation: '运动习惯', evidenceStatus: 'verified', evidence: '合成回执示例' },
      { id: 'fixture-edge-i', source: 'traffic:walk', target: 'traffic:coast', kind: 'traffic-link', relation: '户外地点', evidenceStatus: 'verified', evidence: '合成回执示例' },
      { id: 'fixture-edge-j', source: 'memory:m6', target: 'traffic:stretch', kind: 'memory-link', relation: '替代安排', evidenceStatus: 'verified', evidence: '合成回执示例' },
      { id: 'fixture-edge-k', source: 'traffic:stretch', target: 'traffic:weekend', kind: 'traffic-link', relation: '周末活动', evidenceStatus: 'missing', evidence: '未记录可验证回执' },
      { id: 'fixture-edge-l', source: 'memory:m7', target: 'traffic:weekend', kind: 'memory-link', relation: '周末习惯', evidenceStatus: 'verified', evidence: '合成回执示例' },
      { id: 'fixture-edge-m', source: 'memory:m8', target: 'traffic:coast', kind: 'memory-link', relation: '拍摄地点', evidenceStatus: 'verified', evidence: '合成回执示例' },
      { id: 'fixture-edge-n', source: 'traffic:water', target: 'traffic:coast', kind: 'traffic-link', relation: '地点类型', evidenceStatus: 'verified', evidence: '合成回执示例' },
      { id: 'fixture-edge-o', source: 'memory:m5', target: 'traffic:water', kind: 'memory-link', relation: '运动地点', evidenceStatus: 'verified', evidence: '合成回执示例' }
    ]
}

// Seven synthetic constellations exercise the reference design at its original density.
const constellationSamples = {
  quiet: ['关掉手机提示音', '靠窗读书', '晨间手账', '听完整张专辑', '给自己留半天空白', '傍晚的图书馆', '在露台写信', '独处时听雨'],
  coast: ['涨潮前到达岸边', '沿着栈桥走到底', '傍晚看灯塔', '把海岸线画下来', '拍一组退潮的照片', '在港口等日落', '乘渡轮绕过海湾', '记下海雾散去的时刻'],
  food: ['试试巷口的面馆', '订一张窗边桌', '周末煮番茄汤', '去早市挑蔬菜', '找茶香清淡的店', '留一份晚餐食谱', '做柠檬意面', '早餐烤一片面包'],
  walk: ['记住岔路口的标志', '下班多走一站', '沿河回家', '绕公园一圈', '找一条有树荫的小路', '散步时听一集播客', '在步道尽头休息', '换一条回程路线'],
  water: ['沿湖步道看倒影', '在码头素描', '沿溪流往上走', '看清晨的水面', '去湿地看芦苇', '记下船班时间', '寻找石桥边的长椅', '雨后看池塘'],
  stretch: ['睡前做肩颈拉伸', '午休到楼下活动', '慢慢放松手腕', '跟着节拍呼吸', '轻轻伸展背部', '清晨做十分钟瑜伽', '把瑜伽垫放在窗边', '运动后热敷肩膀'],
  weekend: ['整理上周的相片', '留出周日上午', '约朋友喝茶', '周六看展', '周日去旧书店', '给下周写便笺', '把阳台的花换盆', '在家录一段琴声']
}

export function graphFixture(mode) {
  if (mode === 'empty') return { nodes: [], edges: [] }
  if (mode === 'single') return { nodes: synthetic.nodes.slice(0, 1), edges: [] }
  if (mode === 'partial') return { ...synthetic, partial: ['memory_summary_missing'] }
  if (mode !== '1') return null
  const graph = { nodes: [...synthetic.nodes], edges: [...synthetic.edges] }
  for (const [hub, samples] of Object.entries(constellationSamples)) {
    for (const [i, label] of samples.entries()) {
      const id = `memory:sample-${hub}-${i}`
      graph.nodes.push({ id, type: 'memory', label, summary: label, source: '合成样例', status: 'active' })
      graph.edges.push({ source: id, target: `traffic:${hub}`, kind: 'memory-link', relation: '连接', evidenceStatus: 'missing' })
    }
  }
  // Explicit second attachments in this preview, not a relationship rule for live data.
  for (const [from, index, to] of [
    ['coast',0,'water'],['coast',1,'walk'],['coast',4,'water'],['coast',5,'quiet'],['coast',6,'water'],
    ['walk',1,'stretch'],['walk',2,'water'],['walk',3,'stretch'],['walk',4,'quiet'],['walk',5,'quiet'],
    ['water',0,'walk'],['water',1,'coast'],['water',2,'walk'],['water',3,'quiet'],['water',5,'coast'],
    ['quiet',4,'weekend'],['quiet',7,'water'],['weekend',1,'quiet'],['weekend',2,'food'],['weekend',4,'quiet'],
    ['stretch',1,'walk'],['stretch',3,'quiet'],['stretch',6,'quiet'],['food',2,'weekend']
  ]) {
    graph.edges.push({ source:`memory:sample-${from}-${index}`,target:`traffic:${to}`,kind:'memory-link',
      relation:'相关主题',evidenceStatus:'missing' })
  }
  return graph
}
