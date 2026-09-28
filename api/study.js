export const config = {
  maxDuration: 60,
  // Next.js pages router ke liye (plain Vercel functions me ignore hota hai)
  api: { bodyParser: { sizeLimit: '4mb' } }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sirf 2 models, taaki 60s timeout se pehle fallback ho jaye
const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

const TOTAL_BUDGET_MS = 55000; // maxDuration se thoda kam
const MAX_B64_CHARS = 4.3 * 1024 * 1024; // Vercel 4.5MB limit ke andar

// "data:application/pdf;base64,XXXX" -> { mime, data }
const parseB64 = (s, fallbackMime) => {
  if (typeof s !== 'string') return { mime: fallbackMime, data: '' };
  const m = s.match(/^data:(.*?);base64,(.*)$/s);
  return m ? { mime: m[1], data: m[2] } : { mime: fallbackMime, data: s };
};

async function gemini(parts, json) {
  const start = Date.now();
  let lastError = 'AI Response Error';
  let lastStatus = 0;

  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = TOTAL_BUDGET_MS - (Date.now() - start);
      if (remaining < 4000) {
        return { error: 'AI Error: Request time out ho gaya. Dobara try karein.' };
      }

      try {
        const body = { contents: [{ parts }] };
        if (json) body.generationConfig = { responseMimeType: 'application/json' };

        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': process.env.GEMINI_API_KEY
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.min(remaining, 30000))
        });

        const data = await r.json().catch(() => ({}));

        if (r.ok) {
          const text = (data?.candidates?.[0]?.content?.parts || [])
            .map((p) => p.text || '')
            .join('');
          if (text) return { text };
          lastError = data?.promptFeedback?.blockReason
            ? `Content blocked (${data.promptFeedback.blockReason})`
            : 'Empty response from AI';
          lastStatus = 0;
          break; // is model se khali aaya, next model try karo
        }

        lastStatus = r.status;
        lastError = data?.error?.message || `Status ${r.status}`;

        // 404 = model nahi mila -> next model. Baaki non-retryable errors pe bhi break.
        if (![429, 500, 503].includes(r.status)) break;
      } catch (e) {
        lastError = e.name === 'TimeoutError' ? 'Request timeout' : e.message || 'Server Fetch Error';
      }
      await sleep(1000);
    }
  }

  let msg = 'AI Error: ' + lastError;
  if (lastStatus === 400 || lastStatus === 401 || lastStatus === 403) {
    if (/api key|permission|unauthor/i.test(lastError)) {
      msg += '\n\nKripya GEMINI_API_KEY check karein ki sahi se set hai ya nahi.';
    }
  }
  return { error: msg };
}

// JSON array safely nikalo (markdown fences ya extra text ho to bhi chalega)
const parseJSON = (t) => {
  const clean = t.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const s = clean.indexOf('[');
    const e = clean.lastIndexOf(']');
    if (s === -1 || e === -1) throw new Error('No JSON found');
    return JSON.parse(clean.slice(s, e + 1));
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY missing! Vercel me Environment Variable add karein.'
    });
  }

  const b = req.body || {};
  const bad = (msg, code = 400) => res.status(code).json({ error: msg });
  const send = (out) => res.status(out.error ? 500 : 200).json(out);

  try {
    /* ---------- ROADMAP ---------- */
    if (b.mode === 'roadmap') {
      const { name, days, hours } = b;
      const subjects = Array.isArray(b.subjects) ? b.subjects : [];
      if (!subjects.length) return bad('Kam se kam ek subject add karein');

      const list = subjects
        .map((s) => `- ${s?.name || 'Subject'}: ${s?.chapters || 0} Chapters`)
        .join('\n');
      const prompt = `Tum ek expert study planner ho. Student ka naam: ${name || 'Student'}.
Exam Days Left: ${days}. Daily Study Hours: ${hours}.
Subjects & Chapters:
${list}

Hinglish me ek practical schedule roadmap banao:
1. Daily time division for each subject.
2. Din-wise ya week-wise target plan.
3. Revision tips & mock test advice.
Markdown tables mat use karo. Clear headings aur bullet points use karo.`;

      return send(await gemini([{ text: prompt }], false));
    }

    /* ---------- FLASHCARDS ---------- */
    if (b.mode === 'flashcards') {
      if (!b.pdf) return bad('PDF missing');
      if (b.pdf.length > MAX_B64_CHARS) return bad('PDF bahut badi hai (max ~3MB). Chhoti PDF try karein.', 413);

      const pdf = parseB64(b.pdf, 'application/pdf');
      const pdfPart = { inline_data: { mime_type: 'application/pdf', data: pdf.data } };
      const prompt = `PDF se ${b.count || 15} flashcards banao. Bhasha: ${b.lang || 'Hinglish'}.
Important definitions, formulas, and facts extract karo.
Strictly return JSON array only without markdown: [{"q":"Question text","a":"Answer text"}]`;

      const out = await gemini([{ text: prompt }, pdfPart], true);
      if (out.error) return send(out);

      try {
        return res.status(200).json({ cards: parseJSON(out.text) });
      } catch {
        return bad('Flashcard format error. Dobara try karein.', 500);
      }
    }

    /* ---------- QUIZ ---------- */
    if (b.mode === 'quiz') {
      if (!b.pdf) return bad('PDF missing');
      if (b.pdf.length > MAX_B64_CHARS) return bad('PDF bahut badi hai (max ~3MB). Chhoti PDF try karein.', 413);

      const pdf = parseB64(b.pdf, 'application/pdf');
      const pdfPart = { inline_data: { mime_type: 'application/pdf', data: pdf.data } };
      const prompt = `PDF se ${b.count || 10} Multiple Choice Questions (MCQs) banao. Bhasha: ${b.lang || 'Hinglish'}.
Rules:
- 4 options ho, sirf 1 sahi.
- 3 galat options PDF ke context se related hone chahiye.
- "a" is correct option index (0, 1, 2, or 3).
Strictly return JSON array: [{"q":"Question","o":["Opt1","Opt2","Opt3","Opt4"],"a":0,"why":"Short Explanation"}]`;

      const out = await gemini([{ text: prompt }, pdfPart], true);
      if (out.error) return send(out);

      try {
        return res.status(200).json({ quiz: parseJSON(out.text) });
      } catch {
        return bad('Quiz generate karne me issue aaya. Dobara try karein.', 500);
      }
    }

    /* ---------- DOUBT SOLVER ---------- */
    if (b.mode === 'doubt') {
      if (!b.image) return bad('Image missing');
      if (b.image.length > MAX_B64_CHARS) return bad('Image bahut badi hai. Chhoti image try karein.', 413);

      // Data URL se mime nikalo, warna b.imageMime, warna jpeg
      const img = parseB64(b.image, b.imageMime || 'image/jpeg');
      const imgPart = { inline_data: { mime_type: img.mime, data: img.data } };
      const prompt = `Is photo ke doubt/question ko step-by-step solve karo. Format:
## Question
(Question text)
## Solution Steps
(Clear step by step explanation)
## Final Answer
(Final answer text)`;

      return send(await gemini([{ text: prompt }, imgPart], false));
    }

    /* ---------- DETAILED NOTES ---------- */
    if (b.mode === 'notes') {
      if (!b.subject || !b.topic) return bad('Subject aur Topic dono chahiye');

      const prompt = `Subject: ${b.subject}, Topic: ${b.topic}.
Is topic par fully detailed study notes banao:
1. Definition & Core Concept
2. Important Formulas / Key Points
3. 3 Important Exam Questions with answers.
Simple Hindi/Hinglish language use karo. Headings and bullet points use karo.`;

      return send(await gemini([{ text: prompt }], false));
    }

    return bad('Invalid request');
  } catch (e) {
    return res.status(500).json({ error: 'Server Error: ' + (e.message || 'Unknown') });
  }
  }
