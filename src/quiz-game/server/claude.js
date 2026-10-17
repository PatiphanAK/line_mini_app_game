// Generates quiz questions with Claude through the Anthropic SDK.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

export const hasClaudeKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// The SDK already retries 429/5xx and network errors (2 retries by default).
const client = hasClaudeKey ? new Anthropic({ timeout: 90_000 }) : null;

const SYSTEM_PROMPT = `You are a quiz designer for a live, fast-paced multiplayer quiz game (like Kahoot).
Write clear, unambiguous multiple-choice questions.
Rules:
- Exactly 4 choices per question, exactly ONE correct. answerIndex is its 0-based position.
- Question text <= 120 characters. Each choice <= 60 characters.
- Wrong choices must be plausible, not jokes.
- No "all of the above" / "none of the above".
- Facts must be accurate and well established.
- timeLimit is seconds (10-30), longer for harder or wordier questions.`;

// Structured outputs guarantee the reply parses as this shape;
// validate() below still enforces the game's own limits.
const QUESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          choices: { type: 'array', items: { type: 'string' } },
          answerIndex: { type: 'integer' },
          timeLimit: { type: 'integer' },
        },
        required: ['question', 'choices', 'answerIndex', 'timeLimit'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

export async function generateQuestions({ topic, count = 8, difficulty = 'medium', language = 'English' }) {
  if (!client) throw new Error('ANTHROPIC_API_KEY is not set');

  const userPrompt = `Topic: ${topic}\nNumber of questions: ${count}\nDifficulty: ${difficulty}\nLanguage of questions and choices: ${language}`;

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // On a safety decline, re-run the request on Anthropic's recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: QUESTIONS_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to write questions on this topic');
  if (response.stop_reason === 'max_tokens') throw new Error('Claude response was cut off');
  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const questions = validate(JSON.parse(text));
  if (questions.length === 0) throw new Error('Claude returned no valid questions');
  return questions.slice(0, count);
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

// Used when no API key is configured, or when Claude fails, so the game still runs.
export const FALLBACK_QUESTIONS = [
  { text: 'Which planet is known as the Red Planet?', choices: ['Venus', 'Mars', 'Jupiter', 'Mercury'], answerIndex: 1, timeLimit: 15 },
  { text: 'What does HTML stand for?', choices: ['HyperText Markup Language', 'High Transfer Machine Language', 'Hyperlink Text Mode Language', 'Home Tool Markup Language'], answerIndex: 0, timeLimit: 20 },
  { text: 'What is the capital of Thailand?', choices: ['Chiang Mai', 'Phuket', 'Bangkok', 'Pattaya'], answerIndex: 2, timeLimit: 15 },
  { text: 'Which protocol keeps a full-duplex connection open in the browser?', choices: ['HTTP/1.0', 'FTP', 'SMTP', 'WebSocket'], answerIndex: 3, timeLimit: 20 },
  { text: 'How many sides does a hexagon have?', choices: ['5', '6', '7', '8'], answerIndex: 1, timeLimit: 10 },
].map(shuffleChoices);
