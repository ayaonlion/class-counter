// Vercel Edge Function: /api/diag_52
// 耗时诊断版，使用智谱 glm-5.2 模型

export const config = {
  runtime: 'edge'
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: '只支持 POST' });
  }

  const start = Date.now();
  const { text, students, courses, defaultCourse, defaultDate } = await req.json();

  const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;
  if (!ZHIPU_API_KEY) {
    return jsonResponse(500, { error: '未配置 ZHIPU_API_KEY' });
  }

  const prompt = `你是一位课堂记录助手。请理解用户意图，并返回严格 JSON 格式。

支持的学生：${(students || []).join('、')}
支持的课程：${(courses || []).join('、')}
默认课程：${defaultCourse}
默认日期：${defaultDate}

格式：
{"intent":"update|add|subtract|set|reset|query|summary|unknown","description":"","parameters":{"date":"","course":"","student":"","field":"raise|pick|question|all","value":0,"scope":"all|date|course|student"},"records":[{"date":"","course":"","student":"","raise":0,"pick":0,"question":0}]}

意图：update直接给次数；add在现有基础上增加；subtract减少；set设具体值；reset清零；query查询；summary总结；unknown不理解。
字段：raise主动举手；pick老师点名；question不懂就问。

用户输入："""${text}"""`;

  let content = '';
  let status = null;

  try {
    const fetchStart = Date.now();
    const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': ZHIPU_API_KEY
      },
      body: JSON.stringify({
        model: 'glm-5.2',
        messages: [
          { role: 'system', content: '你是一个严谨的课堂记录意图识别助手，只返回 JSON。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1
      })
    });
    const fetchResponse = Date.now();
    status = response.status;
    const data = await response.json();
    const lastByteAt = Date.now();
    content = data.choices?.[0]?.message?.content || '';

    const parsed = parseJSON(content);
    const parsedAt = Date.now();

    return jsonResponse(200, {
      ok: true,
      model: 'glm-5.2',
      status,
      timings: {
        fetchStart_ms: fetchStart - start,
        fetchResponse_ms: fetchResponse - start,
        lastByte_ms: lastByteAt - start,
        parsed_ms: parsedAt - start,
        total_ms: parsedAt - start
      },
      content,
      parsed
    });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      model: 'glm-5.2',
      status,
      error: err.message,
      content: content ? content.slice(0, 500) : ''
    });
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function parseJSON(content) {
  try {
    const text = content.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
    return JSON.parse(text);
  } catch (e) {
    return { error: 'parse failed', raw: content.slice(0, 300) };
  }
}
