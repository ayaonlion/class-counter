// Vercel Edge Function: /api/parse
// 使用 Edge Runtime 获得 30 秒超时，避免 Serverless 10 秒超时
// 同时支持 Kimi 和智谱 GLM 大模型，通过环境变量 PRIMARY_PROVIDER 控制优先级

export const config = {
  runtime: 'edge'
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: '只支持 POST' });
  }

  const start = Date.now();
  const { text, students, courses, defaultCourse, defaultDate } = await req.json();
  if (!text) return jsonResponse(400, { error: '缺少 text 参数' });

  const KIMI_API_KEY = process.env.KIMI_API_KEY;
  const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;
  const PRIMARY_PROVIDER = (process.env.PRIMARY_PROVIDER || 'zhipu').toLowerCase();

  if (!KIMI_API_KEY && !ZHIPU_API_KEY) {
    return jsonResponse(500, { error: '未配置 KIMI_API_KEY 或 ZHIPU_API_KEY 环境变量' });
  }

  const prompt = buildPrompt({ text, students, courses, defaultCourse, defaultDate });

  const providers = PRIMARY_PROVIDER === 'kimi' ? [
    { name: 'kimi', key: KIMI_API_KEY, call: callKimi },
    { name: 'zhipu', key: ZHIPU_API_KEY, call: callZhipu }
  ] : [
    { name: 'zhipu', key: ZHIPU_API_KEY, call: callZhipu },
    { name: 'kimi', key: KIMI_API_KEY, call: callKimi }
  ];

  let lastError = null;
  for (const provider of providers) {
    if (!provider.key) continue;
    try {
      const content = await provider.call(provider.key, prompt);
      const parsed = parseAndFilter(content, students, courses);
      const total = Date.now() - start;
      return jsonResponse(200, { provider: provider.name, elapsed_ms: total, ...parsed });
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  return jsonResponse(500, { error: '所有可用大模型调用失败', detail: lastError?.message || '无可用模型' });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function buildPrompt({ text, students, courses, defaultCourse, defaultDate }) {
  return `你是一位课堂记录助手。请理解用户意图，并返回严格 JSON 格式。

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

只返回 JSON，不要任何解释文字。

用户输入："""${text}"""`;
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

  parsed.parameters = parsed.parameters || {};

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
