// Vercel Edge Function: /api/debug
// 调试接口：直接返回智谱 API 原始响应

export const config = {
  runtime: 'edge'
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: '只支持 POST' });
  }

  const { text, students, courses, defaultCourse, defaultDate } = await req.json();
  const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;
  if (!ZHIPU_API_KEY) return jsonResponse(500, { error: '未配置 ZHIPU_API_KEY' });

  const prompt = `你是一位课堂记录助手。请理解用户意图，并返回严格 JSON 格式。

支持的学生：${(students || []).join('、')}
支持的课程：${(courses || []).join('、')}
默认课程：${defaultCourse}
默认日期：${defaultDate}

请识别用户意图，返回格式如下：
{
  "intent": "update|add|subtract|set|reset|delete|query|summary|unknown",
  "description": "简短说明你的理解",
  "parameters": {"date": "", "course": "", "student": "", "field": "raise|pick|question|all", "value": 0, "scope": "all|date|course|student"},
  "records": [{"date": "", "course": "", "student": "", "raise": 0, "pick": 0, "question": 0}]
}

意图：update直接给次数；add在现有基础上增加；subtract减少；set设具体值；reset清零；query查询；summary总结；unknown不理解。
字段：raise主动举手；pick老师点名；question不懂就问。

只返回 JSON。

用户输入："""${text}"""`;

  try {
    const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': ZHIPU_API_KEY
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
    const raw = data.choices?.[0]?.message?.content || '';

    return jsonResponse(200, {
      status: response.status,
      raw,
      parsed: safeParse(raw)
    });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function safeParse(raw) {
  try {
    const text = raw.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
    return JSON.parse(text);
  } catch (e) {
    return { parseError: e.message, raw: raw.slice(0, 300) };
  }
}
