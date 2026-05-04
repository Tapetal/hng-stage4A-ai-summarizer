console.log("ENV CHECK:", process.env.GEMINI_API_KEY ? "FOUND" : "MISSING");
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

app.post("/summarize", async (req, res) => {
  try {
    const { content, title } = req.body;

    const prompt = `
Summarize this webpage.

Return ONLY JSON:
{
  "summary": ["point 1", "point 2"],
  "key_insights": ["insight 1"],
  "reading_time_minutes": number,
  "keyPhrases": ["phrase 1"]
}

Content:
${content.slice(0, 6000)}
`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
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
                keyPhrases: { type: "array", items: { type: "string" } }
              }
            }
          }
        }),
      }
    );

    const data = await response.json();

    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: "Failed to summarize" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});