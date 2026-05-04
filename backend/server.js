const express = require("express");
const cors = require("cors");
require("dotenv").config();

const fetch = globalThis.fetch || ((...args) =>
  import("node-fetch").then(({ default: nodeFetch }) => nodeFetch(...args)));

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

console.log("ENV CHECK:", process.env.GEMINI_API_KEY ? "FOUND" : "MISSING");

function buildPrompt(title, content, estimatedReadingTime) {
  return `
You are a helpful assistant that summarizes web pages.

Return ONLY valid JSON in this exact format:
{
  "summary": ["bullet point 1", "bullet point 2", "bullet point 3"],
  "key_insights": ["insight 1", "insight 2"],
  "reading_time_minutes": ${estimatedReadingTime || 1},
  "keyPhrases": ["phrase 1", "phrase 2", "phrase 3"]
}

Rules:
- summary: 3 to 5 concise bullet points covering what the page says.
- key_insights: 2 to 3 deeper takeaways. Do not repeat summary bullets.
- reading_time_minutes: use the provided reading time unless the page clearly suggests otherwise.
- keyPhrases: 4 to 6 short phrases from the page for highlighting.
- Keep language simple, factual, and clear.
- Do not include markdown or text outside the JSON.

Title: "${title || "Untitled page"}"

Estimated page reading time: ${estimatedReadingTime || 1} minutes

Content:
${content.slice(0, 6000)}
`;
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "AI Page Summarizer API" });
});

app.post("/summarize", async (req, res) => {
  try {
    const { title, estimatedReadingTime } = req.body || {};
    const content = req.body?.content || req.body?.text || "";

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Server is missing GEMINI_API_KEY." });
    }

    if (typeof content !== "string" || content.trim().length < 50) {
      return res.status(400).json({ error: "No readable page content received." });
    }

    const prompt = buildPrompt(title, content, estimatedReadingTime);

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1024,
          responseMimeType: "application/json",
          responseJsonSchema: {
            type: "object",
            properties: {
              summary: { type: "array", items: { type: "string" } },
              key_insights: { type: "array", items: { type: "string" } },
              reading_time_minutes: { type: "number" },
              keyPhrases: { type: "array", items: { type: "string" } },
            },
            required: ["summary", "key_insights", "reading_time_minutes", "keyPhrases"],
          },
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const message = data?.error?.message || `Gemini request failed with status ${response.status}`;
      console.error("Gemini API error:", message);
      return res.status(response.status).json({ error: message });
    }

    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!text) {
      console.error("Gemini returned no text:", JSON.stringify(data).slice(0, 1000));
      return res.status(502).json({ error: "Gemini returned an empty summary." });
    }

    res.json({ text });
  } catch (err) {
    console.error("Summarize route failed:", err);
    res.status(500).json({ error: err.message || "Failed to summarize" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
