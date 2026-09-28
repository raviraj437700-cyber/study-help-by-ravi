export const config = { maxDuration: 60 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Official updated models list
const MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-flash'
];

async function gemini(parts, json) {
  let lastError = 'AI Response Error';

  for (const model of MODELS) {
    const URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const body = { contents: [{ parts }] };
        if (json) {
          body.generationConfig = { responseMimeType: 'application/json' };
        }

        const r = await fetch(`${URL}?key=${process.env.GEMINI_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        const data = await r.json();

        if (r.ok && data?.candidates?.[0]?.content?.parts) {
          const text = data.candidates[0].content.parts.map(p => p.text).join('');
          if (text) return { text };
        }

        lastError = data?.error?.message || `Status ${r.status}`;
        if (![429, 500, 503].includes(r.status)) break;
      } catch (e) {
        lastError = e.message || 'Server Fetch Error';
      }
      await sleep(1200);
    }
  }

  return { error: 'AI Error: ' + lastError + '\n\nKripya GEMINI_API_KEY check karein ki sahi se set hai ya nahi.' };
}

const parseJSON = (t) => {
  const clean = t.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });
  
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY missing! Vercel me Environment Variable add karein.' });
  }

  const b = req.body || {};
  const bad = (msg) => res.status(400).json({ error: msg });

  /* ---------- ROADMAP ---------- */
  if (b.mode === 'roadmap') {
    const { name, days, hours, subjects } = b;
    const list = subjects.map(s => `- ${s.name}: ${s.chapters} Chapters`).join('\n');
    const prompt = `Tum ek expert study planner ho. Student ka naam: ${name || 'Student'}.
Exam Days Left: ${days}. Daily Study Hours: ${hours}.
Subjects & Chapters:
${list}

Hinglish me ek practical schedule roadmap banao:
1. Daily time division for each subject.
2. Din-wise ya week-wise target plan.
3. Revision tips & mock test advice.
Markdown tables mat use karo. Clear headings aur bullet points use karo.`;

    const out = await gemini([{ text: prompt }], false);
    return res.status(200).json(out);
  }

  /* ---------- FLASHCARDS ---------- */
  if (b.mode === 'flashcards') {
    if (!b.pdf) return bad('PDF missing');
    const pdfPart = { inline_data: { mime_type: 'application/pdf', data: b.pdf } };
    const prompt = `PDF se ${b.count || 15} flashcards banao. Bhasha: ${b.lang || 'Hinglish'}.
Important definitions, formulas, and facts extract karo.
Strictly return JSON array only without markdown: [{"q":"Question text","a":"Answer text"}]`;

    const out = await gemini([{ text: prompt }, pdfPart], true);
    if (out.error) return res.status(500).json(out);
    
    try {
      const cards = parseJSON(out.text);
      return res.status(200).json({ cards });
    } catch(e) {
      return res.status(500).json({ error: 'Flashcard format error. Dobara try karein.' });
    }
  }

  /* ---------- QUIZ ---------- */
  if (b.mode === 'quiz') {
    if (!b.pdf) return bad('PDF missing');
    const pdfPart = { inline_data: { mime_type: 'application/pdf', data: b.pdf } };
    const prompt = `PDF se ${b.count || 10} Multiple Choice Questions (MCQs) banao. Bhasha: ${b.lang || 'Hinglish'}.
Rules:
- 4 options ho, sirf 1 sahi.
- 3 galat options PDF ke context se related hone chahiye.
- "a" is correct option index (0, 1, 2, or 3).
Strictly return JSON array: [{"q":"Question","o":["Opt1","Opt2","Opt3","Opt4"],"a":0,"why":"Short Explanation"}]`;

    const out = await gemini([{ text: prompt }, pdfPart], true);
    if (out.error) return res.status(500).json(out);

    try {
      const quiz = parseJSON(out.text);
      return res.status(200).json({ quiz });
    } catch(e) {
      return res.status(500).json({ error: 'Quiz generate karne me issue aaya. Dobara try karein.' });
    }
  }

  /* ---------- DOUBT SOLVER ---------- */
  if (b.mode === 'doubt') {
    if (!b.image) return bad('Image missing');
    const imgPart = { inline_data: { mime_type: 'image/jpeg', data: b.image } };
    const prompt = `Is photo ke doubt/question ko step-by-step solve karo. Format:
## Question
(Question text)
## Solution Steps
(Clear step by step explanation)
## Final Answer
(Final answer text)`;

    const out = await gemini([{ text: prompt }, imgPart], false);
    return res.status(200).json(out);
  }

  /* ---------- DETAILED NOTES ---------- */
  if (b.mode === 'notes') {
    const prompt = `Subject: ${b.subject}, Topic: ${b.topic}.
Is topic par fully detailed study notes banao:
1. Definition & Core Concept
2. Important Formulas / Key Points
3. 3 Important Exam Questions with answers.
Simple Hindi/Hinglish language use karo. Headings and bullet points use karo.`;

    const out = await gemini([{ text: prompt }], false);
    return res.status(200).json(out);
  }

  return bad('Invalid request');
}
