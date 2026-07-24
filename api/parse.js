// Vercel Serverless Function: /api/parse
// 同时支持 Kimi 和智谱 GLM 大模型，优先尝试 Kimi，失败时自动切换到智谱
// 升级为意图路由模式：识别用户意图，返回结构化操作指令
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只支持 POST' });
  }

  const KIMI_API_KEY = process.env.KIMI_API_KEY;
  const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;

  if (!KIMI_API_KEY && !ZHIPU_API_KEY) {
    return res.status(500).json({ error: '未配置 KIMI_API_KEY 或 ZHIPU_API_KEY 环境变量' });
  }

  const { text, students, courses, defaultCourse, defaultDate, history } = req.body;
  if (!text) return res.status(400).json({ error: '缺少 text 参数' });

  const prompt = `你是一位课堂记录助手。请理解用户意图，并返回严格 JSON 格式。

支持的学生：${(students || []).join('、')}
支持的课程：${(courses || []).join('、')}
默认课程：${defaultCourse}
默认日期：${defaultDate}

请识别用户意图，返回格式如下：
{
  "intent": "update|add|subtract|set|reset|delete|query|summary|unknown",
  "description": "简短说明你的理解",
  "parameters": {
    "date": "YYYY-MM-DD 或 null",
    "course": "课程名 或 null",
    "student": "学生名 或 null",
    "field": "raise|pick|question|all",
    "value": "数值（整数）",
    "scope": "all|date|course|student"
  },
  "records": [
    // update/add/subtract 意图需要；add/subtract 表示在现有基础上增加/减少
    {"date": "2026-07-24", "course": "英语(殷)", "student": "小明", "raise": 1, "pick": 0, "question": 0}
  ]
}

意图说明（理解语义，不要死记字面）：
- update: 用户直接给出一个最终的具体次数。例如："今天英语课小明举手3次""老师点名2次""不懂问了1次"。
- add: 用户表达的是"在当前记录的基础上再增加/追加/多 N 次"。只要语义是"增加"，不管具体措辞是什么（"加一次""+1次""多一次""再来一次""追加一次""翻倍"），都应该识别为 add。默认增加对象是主动举手（raise），除非上下文明确指向老师点名或不懂就问。翻倍时 value 填翻倍后的目标值（如当前 1 次翻倍则为 2）。
- subtract: 用户表达的是"在当前记录的基础上减少 N 次"。例如："减一次""少一次""-1次"。
- set: 用户明确要把某个值设为具体数字。例如："把今天英语课举手次数设为5""改成3次"。
- reset: 用户要把某些记录清零。例如："重置所有主动举手次数""全部清零"。
- delete: 删除记录，如"删除昨天数学课小明的记录"。
- query: 查询统计，如"这周谁举手最多""今天英语课小明举手几次"。
- summary: 总结，如"总结本周表现"。
- unknown: 完全无法理解。

字段对应：
- raise: 主动举手 / 举手 / 主动回答 / 发言 / 抢答
- pick: 老师点名 / 点名 / 被点到 / 老师叫到
- question: 不懂就问 / 提问 / 问问题 / 不会 / 问了 / 求助

示例：
- "今天英语课举手3次" → update, records: [{"raise":3}]
- "今天英语课举手加一次" → add, records: [{"raise":1}]
- "今天英语课举手+1次" → add, records: [{"raise":1}]
- "今天英语课举手多一次" → add, records: [{"raise":1}]
- "今天英语课举手再来一次" → add, records: [{"raise":1}]
- "今天英语课举手翻倍" → add, records: [{"raise":2}]
- "昨天语文课老师点名加一次" → add, records: [{"pick":1}]
- "数学课不懂的问加两次" → add, records: [{"question":2}]
- "今天英语课举手减一次" → subtract, records: [{"raise":1}]
- "把今天英语课举手次数设为5" → set, parameters: {"value":5}
- "重置所有主动举手次数" → reset, parameters: {"field":"raise", "scope":"all"}

只返回 JSON，不要任何解释文字。

用户输入："""${text}"""`;

  // 1. 优先尝试 Kimi
  if (KIMI_API_KEY) {
    try {
      const result = await callKimi(KIMI_API_KEY, prompt);
      const parsed = await parseAndFilter(result, students, courses);
      return res.json({ provider: 'kimi', ...parsed });
    } catch (err) {
      if (!ZHIPU_API_KEY) {
        return res.status(500).json({ error: 'Kimi 调用失败，且未配置智谱 Key', detail: err.message });
      }
    }
  }

  // 2. 尝试智谱
  if (ZHIPU_API_KEY) {
    try {
      const result = await callZhipu(ZHIPU_API_KEY, prompt);
      const parsed = await parseAndFilter(result, students, courses);
      return res.json({ provider: 'zhipu', ...parsed });
    } catch (err) {
      return res.status(500).json({ error: '智谱调用失败', detail: err.message });
    }
  }

  res.status(500).json({ error: '无可用大模型' });
}

async function callKimi(apiKey, prompt) {
  const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'moonshot-v1-8k',
      messages: [
        { role: 'system', content: '你是一个严谨的课堂记录意图识别助手，只返回 JSON。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1
    })
  });

  const data = await response.json();
  if (!response.ok || !data.choices || !data.choices[0]) {
    throw new Error(data.error?.message || 'Kimi API 返回异常');
  }
  return data.choices[0].message.content;
}

async function callZhipu(apiKey, prompt) {
  const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `${apiKey}`
    },
    body: JSON.stringify({
      model: 'glm-4.5-air',
      messages: [
        { role: 'system', content: '你是一个严谨的课堂记录意图识别助手，只返回 JSON。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1
    })
  });

  const data = await response.json();
  if (!response.ok || !data.choices || !data.choices[0]) {
    throw new Error(data.error?.message || '智谱 API 返回异常');
  }
  return data.choices[0].message.content;
}

async function parseAndFilter(content, students, courses) {
  let text = content.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('解析 JSON 失败');
  }

  // 规范化参数
  parsed.parameters = parsed.parameters || {};

  // 如果是 update / add / subtract 意图，过滤并规范化 records
  if (parsed.intent === 'update' || parsed.intent === 'add' || parsed.intent === 'subtract') {
    const validStudents = students || [];
    const validCourses = courses || [];
    parsed.records = (parsed.records || []).filter(r => {
      return validStudents.includes(r.student) && validCourses.includes(r.course);
    }).map(r => ({
      date: r.date,
      course: r.course,
      student: r.student,
      raise: Math.max(0, parseInt(r.raise || 0, 10)),
      pick: Math.max(0, parseInt(r.pick || 0, 10)),
      question: Math.max(0, parseInt(r.question || 0, 10))
    }));
  }

  return parsed;
}
