import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: {
    success: false,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Preveč zahtev. Poskusi ponovno čez minuto.",
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
});
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function errorResponse(res, status, code, message) {
  return res.status(status).json({
    success: false,
    error: {
      code,
      message,
    },
  });
}

app.post("/chat", aiLimiter, async (req, res) => {
  try {
    const { message, userData } = req.body;
    return errorResponse(
  res,
  500,
  "AI_RESPONSE_FAILED",
  "Trenutno je prišlo do napake. Poskusi malo kasneje."
);

    const userName = userData?.name || "uporabnik";
    const userChallenges = userData?.challenges?.length
      ? userData.challenges.join(", ")
      : "ni navedeno";

    const systemPrompt = `
You are Selfly, a calm and supportive AI assistant for emotional wellbeing.
Write in Slovenian.
Be warm, gentle and practical.
Do not diagnose.
Do not claim to be a therapist or doctor.
User name: ${userName}
User challenges: ${userChallenges}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.7,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: message,
        },
      ],
    });

    res.json({
      reply: completion.choices[0].message.content,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      error: "Trenutno je prišlo do napake. Poskusi malo kasneje.",
    });
  }
});

app.post("/insight", aiLimiter, async (req, res) => {
  try {
    const { conversation } = req.body;

    return errorResponse(res, 400, "MISSING_CONVERSATION", "Manjka vsebina pogovora.");

    const systemPrompt = `
You are Selfly, an AI assistant for emotional wellbeing.
Write in Slovenian.
Your task is to extract one short, helpful emotional insight from the user's conversation.
Do not diagnose.
Do not claim to be a therapist or doctor.
Be gentle, practical and clear.

Return only one insight sentence.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.5,
      max_tokens: 150,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: conversation,
        },
      ],
    });

    res.json({
      insight: completion.choices[0].message.content,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      error: "Trenutno ni mogoče ustvariti vpogleda. Poskusi malo kasneje.",
    });
  }
});

app.post("/memory", aiLimiter, async (req, res) => {
  try {
    const { conversation } = req.body;

    return errorResponse(res, 400, "MISSING_CONVERSATION", "Manjka vsebina pogovora.");

    const systemPrompt = `
You are Selfly.
Write in Slovenian.

Your task is to extract ONE important long-term memory about the user.

Examples:
- User struggles with anxiety.
- User wants to improve self-confidence.
- User often feels overwhelmed at work.

Return only one short memory sentence.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.3,
      max_tokens: 100,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: conversation,
        },
      ],
    });

    res.json({
      memory: completion.choices[0].message.content,
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      error: "Napaka pri ustvarjanju memory zapisa.",
    });
  }
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});