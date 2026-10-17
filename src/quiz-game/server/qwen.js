// Generates quiz questions with Qwen through DashScope's OpenAI-compatible API.

const BASE_URL = process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const MODEL = process.env.QWEN_MODEL || 'qwen3.8-flash';
const API_KEY = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY;

export const hasQwenKey = Boolean(API_KEY);

const SYSTEM_PROMPT = `You are a quiz designer for a live, fast-paced multiplayer quiz game (like Kahoot).
Write clear, unambiguous multiple-choice questions.
Rules:
- Exactly 4 choices per question, exactly ONE correct.
- Question text <= 120 characters. Each choice <= 60 characters.
- Wrong choices must be plausible, not jokes.
- No "all of the above" / "none of the above".
- Facts must be accurate and well established.
Respond ONLY with JSON in this shape:
{"questions":[{"question":"...","choices":["...","...","...","..."],"answerIndex":0,"timeLimit":20}]}
timeLimit is seconds (10-30), longer for harder or wordier questions.`;

export async function generateQuestions({ topic, count = 8, difficulty = 'medium', language = 'English' }) {
  if (!API_KEY) throw new Error('QWEN_API_KEY is not set');

  const userPrompt = `Topic: ${topic}\nNumber of questions: ${count}\nDifficulty: ${difficulty}\nLanguage of questions and choices: ${language}`;

  let lastErr;
  // One retry: LLMs occasionally return malformed or invalid JSON.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.8,
          response_format: { type: 'json_object' },
          // JSON mode needs non-thinking mode on Qwen3 models; it is also faster.
          enable_thinking: false,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`Qwen API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? '';
      const questions = validate(JSON.parse(stripFences(content)));
      if (questions.length === 0) throw new Error('Qwen returned no valid questions');
      return questions.slice(0, count);
    } catch (err) {
      lastErr = err;
      console.warn(`[qwen] attempt ${attempt + 1} failed:`, err.message);
    }
  }
  throw lastErr;
}

function stripFences(s) {
  return s.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
}

// Keep only well-formed questions, then shuffle choices so the correct
// answer isn't always in the same slot (LLMs love answerIndex 0).
function validate(payload) {
  const list = Array.isArray(payload) ? payload : payload?.questions;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const q of list) {
    if (typeof q?.question !== 'string' || !Array.isArray(q.choices) || q.choices.length !== 4) continue;
    const choices = q.choices.map((c) => String(c).trim().slice(0, 80));
    const answerIndex = Number(q.answerIndex);
    if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) continue;
    if (new Set(choices).size !== 4 || choices.some((c) => !c)) continue;
    const timeLimit = Math.min(30, Math.max(10, Number(q.timeLimit) || 20));
    out.push(shuffleChoices({ text: q.question.trim().slice(0, 200), choices, answerIndex, timeLimit }));
  }
  return out;
}

function shuffleChoices(q) {
  const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
  return {
    ...q,
    choices: order.map((i) => q.choices[i]),
    answerIndex: order.indexOf(q.answerIndex),
  };
}

// Used when no API key is configured, or when Qwen fails, so the game still runs.
export const FALLBACK_QUESTIONS = [
  { text: 'Which planet is known as the Red Planet?', choices: ['Venus', 'Mars', 'Jupiter', 'Mercury'], answerIndex: 1, timeLimit: 15 },
  { text: 'What does HTML stand for?', choices: ['HyperText Markup Language', 'High Transfer Machine Language', 'Hyperlink Text Mode Language', 'Home Tool Markup Language'], answerIndex: 0, timeLimit: 20 },
  { text: 'What is the capital of Thailand?', choices: ['Chiang Mai', 'Phuket', 'Bangkok', 'Pattaya'], answerIndex: 2, timeLimit: 15 },
  { text: 'Which protocol keeps a full-duplex connection open in the browser?', choices: ['HTTP/1.0', 'FTP', 'SMTP', 'WebSocket'], answerIndex: 3, timeLimit: 20 },
  { text: 'How many sides does a hexagon have?', choices: ['5', '6', '7', '8'], answerIndex: 1, timeLimit: 10 },
].map(shuffleChoices);
