// Vercel Edge Function: /api/parse
// 版本: 2026-07-24 18:37
// 简化版，直接调用智谱并返回过滤后的意图结果，带 raw 调试字段

export const config = {
  runtime: 'edge'
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: '只支持 POST' });
  }

  const start = Date.now();
  const body = await req.json();
  const { text, students, courses, defaultCourse, defaultDate } = body;

  if (!text) return jsonResponse(400, { error: '缺少 text 参数' });

  const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;
  if (!ZHIPU_API_KEY) {
    return jsonResponse(500, { error: '未配置 ZHIPU_API_KEY' });
  }

  const prompt = buildPrompt({ text, students, courses, defaultCourse, defaultDate });

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
    const parsed = parseJSON(raw);
    const filtered = filterRecords(parsed, students, courses);
    const elapsed = Date.now() - start;

    return jsonResponse(200, {
      provider: 'zhipu',
      elapsed_ms: elapsed,
      raw: raw.slice(0, 500),
      parsed_ok: !!parsed.intent,
      ...filtered
    });
  } catch (err) {
    return jsonResponse(500, { error: err.message, stack: err.stack });
  }
}

function buildPrompt({ text, students, courses, defaultCourse, defaultDate }) {
  return `你是一位课堂记录助手。请理解用户意图，并返回严格 JSON 格式。

支持的学生：${(students || []).join('、')}
支持的课程：${(courses || []).join('、')}
默认课程：${defaultCourse}
默认日期：${defaultDate}

格式：
{"intent":"update|add|subtract|set|reset|delete|query|summary|unknown","description":"","parameters":{"date":"","course":"","student":"","field":"raise|pick|question|all","value":0,"scope":"all|date|course|student"},"records":[{"date":"","course":"","student":"","raise":0,"pick":0,"question":0}]}

意图：update直接给次数；add在现有基础上增加；subtract减少；set设具体值；reset清零；delete删除；query查询；summary总结；unknown不理解。
字段：raise主动举手；pick老师点名；question不懂就问。

只返回 JSON，不要解释。

用户输入："""${text}"""`;
}

function parseJSON(raw) {
  const text = raw.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
  return JSON.parse(text);
}

function filterRecords(parsed, students, courses) {
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

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
