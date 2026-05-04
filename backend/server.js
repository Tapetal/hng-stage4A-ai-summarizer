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

function cleanText(text) {
  const noisePattern = /\b(cookie|cookies|privacy policy|subscribe|subscription|advertisement|advertising|sign in|sign up|log in|newsletter|accept all|manage preferences|share this|follow us)\b/i;
  const seen = new Set();
  const lines = String(text || "")
    .split(/\n+/)
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(line => line.length >= 25)
    .filter(line => {
      if (noisePattern.test(line) && line.length < 140) return false;
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (lines.length) {
    return lines.join("\n").slice(0, 8000);
  }

  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(noisePattern, "")
    .trim()
    .slice(0, 8000);
}

function buildPrompt(title, content, estimatedReadingTime) {
  return `
You are a precise web page summarizer.

Return ONLY valid JSON:
{
  "summary": ["3-5 clear bullet points"],
  "key_insights": ["2-3 deeper insights"],
  "reading_time_minutes": ${estimatedReadingTime || 1},
  "keyPhrases": ["4-6 short phrases"]
}

Rules:
- Do NOT return empty arrays.
- If the page is an article, summarize the article's main claims and details.
- If the page is a listing or news index, summarize the main topics/headlines visible on the page.
- If content is weak or fragmented, still extract the most meaningful points.
- Do NOT repeat the same point in summary and key_insights.
- Keep language simple, factual, and clear.
- Do not include markdown or text outside the JSON.

Title: "${title || "Untitled page"}"

Estimated page reading time: ${estimatedReadingTime || 1} minutes

Content:
${content.slice(0, 7000)}
`;
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          return String(item.text || item.summary || item.point || item.insight || "").trim();
        }
        return "";
      })
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/\n+/)
      .map(line => line.replace(/^[-•*\d.)\s]+/, "").trim())
      .filter(Boolean);
  }

  return [];
}

function findListByKey(value, keys, allowDirectArray = false) {
  if (!value || typeof value !== "object") return [];

  if (Array.isArray(value)) {
    if (allowDirectArray) {
      const direct = normalizeList(value);
      if (direct.length) return direct;
    }

    for (const item of value) {
      const nested = findListByKey(item, keys);
      if (nested.length) return nested;
    }
    return [];
  }

  for (const key of keys) {
    const direct = normalizeList(value[key]);
    if (direct.length) return direct;

    const nested = findListByKey(value[key], keys, true);
    if (nested.length) return nested;
  }

  for (const child of Object.values(value)) {
    const nested = findListByKey(child, keys);
    if (nested.length) return nested;
  }

  return [];
}

function parseAndNormalizeGeminiText(text, estimatedReadingTime) {
  try {
    const cleaned = String(text || "")
      .replace(/^```(?:json)?\n?/i, "")
      .replace(/\n?```$/i, "")
      .trim();
    const jsonText = cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned.match(/\[[\s\S]*\]/)?.[0] || cleaned;
    const parsed = JSON.parse(jsonText);

    const summary = findListByKey(parsed, ["summary", "bullets", "bulletPoints", "keyPoints", "points"]);
    const keyInsights = findListByKey(parsed, ["key_insights", "insights", "keyInsights", "takeaways"]);
    const keyPhrases = findListByKey(parsed, ["keyPhrases", "keywords", "phrases", "terms"]);

    if (!summary.length) return null;

    return {
      summary: summary.slice(0, 5),
      key_insights: keyInsights.slice(0, 3),
      reading_time_minutes: Number(parsed.reading_time_minutes) || estimatedReadingTime || 1,
      keyPhrases: keyPhrases.slice(0, 6),
    };
  } catch (_) {
    return null;
  }
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

    const cleanedContent = cleanText(content);

    if (cleanedContent.length < 120) {
      return res.status(400).json({ error: "Not enough meaningful page content after cleaning." });
    }

    const prompt = buildPrompt(title, cleanedContent, estimatedReadingTime);

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

    const normalized = parseAndNormalizeGeminiText(text, estimatedReadingTime);
    res.json({
      text: normalized ? JSON.stringify(normalized) : text,
      source: normalized ? "gemini-normalized" : "gemini-raw",
    });
  } catch (err) {
    console.error("Summarize route failed:", err);
    res.status(500).json({ error: err.message || "Failed to summarize" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
