import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();

app.set("trust proxy", 1);

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

function buildChatPrompt({ userData, moduleType, memories = [] }) {
  const userName = userData?.name || "uporabnik";
  const userChallenges = userData?.challenges?.length
    ? userData.challenges.join(", ")
    : "ni navedeno";

  const modulePrompts = {
    stres:
      "Focus on stress regulation, grounding, reducing pressure and small practical steps.",
    tesnoba: `
You are currently helping a user inside the Anxiety module.

Your focus:
- emotional safety
- calming the nervous system
- reducing overwhelm
- grounding in the present moment
- separating thoughts from facts

Important:
- do not amplify fear
- do not catastrophize
- avoid excessive reassurance
- encourage observation instead of fighting thoughts
- normalize anxiety responses

Use techniques such as:
- grounding
- breathing awareness
- body awareness
- emotional labeling
- small present-moment actions

When appropriate:
- help the user identify triggers
- help the user slow racing thoughts
- help the user return attention to what is happening right now

Always respond with warmth, calmness and emotional safety.
`,
    spanec:
      "Focus on sleep support, evening calm, racing thoughts and reducing pressure around sleep.",
    samozavest:
      "Focus on self-worth, inner confidence, self-trust and gentle encouragement.",
    odnosi:
      "Focus on relationships, boundaries, communication and emotional clarity.",
    motivacija:
      "Focus on motivation, small steps, energy, routine and realistic progress.",
  };

  const selectedModulePrompt =
    modulePrompts[moduleType] || "Focus on general emotional wellbeing.";

  const memoryText = Array.isArray(memories) && memories.length
    ? memories.map((memory) => `- ${memory}`).join("\n")
    : "No long-term memories yet.";

  return `
You are Selfly, a calm and supportive AI assistant for emotional wellbeing.

Core rules:
- Write in Slovenian.
- Be warm, gentle and practical.
- Use short, clear paragraphs.
- Validate the user's emotion first.
- Ask at most one reflective question.
- Do not diagnose.
- Do not claim to be a therapist or doctor.
- Encourage one small realistic next step.

User profile:
- Name: ${userName}
- Challenges: ${userChallenges}

Active module:
${selectedModulePrompt}

Long-term memory:
${memoryText}
`;
}

app.post("/chat", aiLimiter, async (req, res) => {
  try {
    const { message, userData, moduleType, memories } = req.body;

    if (!message || !message.trim()) {
      return errorResponse(res, 400, "MISSING_MESSAGE", "Manjka sporočilo.");
    }

    const systemPrompt = buildChatPrompt({
      userData,
      moduleType,
      memories,
    });

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

    if (!conversation || !conversation.trim()) {
      return errorResponse(
        res,
        400,
        "MISSING_CONVERSATION",
        "Manjka vsebina pogovora."
      );
    }

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

    if (!conversation || !conversation.trim()) {
      return errorResponse(
        res,
        400,
        "MISSING_CONVERSATION",
        "Manjka vsebina pogovora."
      );
    }

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