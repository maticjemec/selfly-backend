import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import {
  MAX_ANALYSIS_MESSAGES,
  MAP_SUGGESTIONS_RESPONSE_FORMAT,
  buildMapSuggestionsPrompt,
  hasEnoughEvidence,
  parseMapSuggestionsResponse,
  prepareAnalysisMessages,
  validateMapSuggestions,
} from "./mapSuggestions.js";
import { isValidUuid, validateMapSuggestionRequest } from "./requestValidation.js";
import { createTtlCache } from "./ttlCache.js";

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

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return errorResponse(
      res,
      401,
      "UNAUTHORIZED",
      "Manjka veljavna avtentikacija."
    );
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    return errorResponse(
      res,
      401,
      "UNAUTHORIZED",
      "Manjka veljavna avtentikacija."
    );
  }

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    return errorResponse(
      res,
      401,
      "UNAUTHORIZED",
      "Manjka veljavna avtentikacija."
    );
  }

  req.user = { id: user.id };
  req.accessToken = token;
  next();
}

function errorResponse(res, status, code, message) {
  return res.status(status).json({
    success: false,
    error: {
      code,
      message,
    },
  });
}

const VALID_MODULE_TYPES = new Set([
  "general",
  "stres",
  "tesnoba",
  "spanec",
  "samozavest",
  "odnosi",
  "motivacija",
]);

const MAX_HISTORY_MESSAGES = 20;

function createUserSupabaseClient(accessToken) {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

function normalizeChallenges(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string");
  }

  if (typeof value === "string" && value.trim()) {
    return [value];
  }

  return [];
}

async function loadChatContext({ accessToken, conversationId, message }) {
  const userClient = createUserSupabaseClient(accessToken);
  const trimmedMessage = message.trim();

  const { data: profile, error: profileError } = await userClient
    .from("profiles")
    .select("nickname, age, gender, challenges")
    .maybeSingle();

  if (profileError) {
    throw profileError;
  }

  let moduleType = "general";
  let history = [];

  if (conversationId) {
    if (!isValidUuid(conversationId)) {
      return {
        error: {
          status: 400,
          code: "INVALID_CONVERSATION_ID",
          message: "Neveljaven ID pogovora.",
        },
      };
    }

    const { data: conversation, error: conversationError } = await userClient
      .from("conversations")
      .select("id, module_type")
      .eq("id", conversationId)
      .maybeSingle();

    if (conversationError) {
      throw conversationError;
    }

    if (!conversation) {
      return {
        error: {
          status: 404,
          code: "CONVERSATION_NOT_FOUND",
          message: "Pogovor ni bil najden.",
        },
      };
    }

    if (
      conversation.module_type &&
      VALID_MODULE_TYPES.has(conversation.module_type)
    ) {
      moduleType = conversation.module_type;
    }

    const { data: messageRows, error: messagesError } = await userClient
      .from("messages")
      .select("role, text, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (messagesError) {
      throw messagesError;
    }

    let validMessages = (messageRows || [])
      .filter((row) => row.role === "user" || row.role === "assistant")
      .map((row) => ({
        role: row.role,
        content: row.text,
      }));

    const lastMessage = validMessages[validMessages.length - 1];

    if (
      lastMessage?.role === "user" &&
      lastMessage.content.trim() === trimmedMessage
    ) {
      validMessages = validMessages.slice(0, -1);
    }

    history = validMessages.slice(-MAX_HISTORY_MESSAGES);
  }

  const { data: moodEntries, error: moodError } = await userClient
    .from("mood_entries")
    .select("mood")
    .order("created_at", { ascending: false })
    .limit(1);

  if (moodError) {
    throw moodError;
  }

  const { data: memoryRows, error: memoryError } = await userClient
    .from("user_memory")
    .select("content")
    .eq("active", true)
    .eq("memory_type", "confirmed")
    .order("importance_score", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(10);

  if (memoryError) {
    throw memoryError;
  }

  const userData = {
    name: profile?.nickname || "uporabnik",
    age: profile?.age || null,
    gender: profile?.gender || null,
    challenges: normalizeChallenges(profile?.challenges),
    latestMood: moodEntries?.[0]?.mood ?? null,
  };

  const memories = (memoryRows || [])
    .map((row) => row.content)
    .filter((content) => typeof content === "string" && content.trim());

  return {
    userData,
    moduleType,
    memories,
    history,
  };
}

const MIN_INSIGHT_USER_MESSAGES = 2;
const MAX_INSIGHT_USER_MESSAGES = 20;

async function loadInsightContext({ accessToken, conversationId }) {
  if (!conversationId || !String(conversationId).trim()) {
    return {
      error: {
        status: 400,
        code: "MISSING_CONVERSATION_ID",
        message: "Manjka ID pogovora.",
      },
    };
  }

  if (!isValidUuid(conversationId)) {
    return {
      error: {
        status: 400,
        code: "INVALID_CONVERSATION_ID",
        message: "Neveljaven ID pogovora.",
      },
    };
  }

  const userClient = createUserSupabaseClient(accessToken);

  const { data: conversation, error: conversationError } = await userClient
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .maybeSingle();

  if (conversationError) {
    throw conversationError;
  }

  if (!conversation) {
    return {
      error: {
        status: 404,
        code: "CONVERSATION_NOT_FOUND",
        message: "Pogovor ni bil najden.",
      },
    };
  }

  const { data: messageRows, error: messagesError } = await userClient
    .from("messages")
    .select("role, text, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (messagesError) {
    throw messagesError;
  }

  const userMessages = (messageRows || [])
    .filter((row) => row.role === "user")
    .map((row) => row.text.trim())
    .filter(Boolean)
    .slice(-MAX_INSIGHT_USER_MESSAGES);

  if (userMessages.length < MIN_INSIGHT_USER_MESSAGES) {
    return {
      skipped: true,
      userMessages,
    };
  }

  const conversationText = userMessages.map((text) => `- ${text}`).join("\n");

  return {
    skipped: false,
    conversationText,
  };
}

async function detectCrisis(message) {
  const moderation = await openai.moderations.create({
    model: "omni-moderation-latest",
    input: message,
  });

  const result = moderation.results?.[0];

  if (!result) {
    return {
      detected: false,
      riskLevel: "none",
      categories: {},
    };
  }

  const categories = result.categories || {};
  const scores = result.category_scores || {};

  const hasIntent =
    categories["self-harm/intent"] === true ||
    scores["self-harm/intent"] >= 0.5;

  const hasInstructions =
    categories["self-harm/instructions"] === true ||
    scores["self-harm/instructions"] >= 0.5;

  const hasSelfHarm =
    categories["self-harm"] === true ||
    scores["self-harm"] >= 0.5;

  if (hasIntent || hasInstructions) {
    return {
      detected: true,
      riskLevel: "high",
      categories,
    };
  }

  if (hasSelfHarm) {
    return {
      detected: true,
      riskLevel: "concern",
      categories,
    };
  }

  return {
    detected: false,
    riskLevel: "none",
    categories,
  };
}


async function extractMemory(userMessage) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 100,
    messages: [
      {
        role: "system",
        content: `
You extract useful long-term memories about a user from their message.

Write the result in Slovenian.

Save only information that may be useful in future conversations, such as:
- important goals
- recurring fears or emotional patterns
- important relationships
- long-term life circumstances
- personal preferences
- values
- important responsibilities
- recurring challenges

Do not save:
- greetings
- temporary moods without wider meaning
- small daily events
- assistant responses
- vague or generic statements
- crisis or self-harm content
- medical diagnoses or assumptions

Return ONLY valid JSON.

If no useful memory exists:

{
  "memory": null,
  "importanceScore": 0,
  "category": null
}

Otherwise:

{
  "memory": "...",
  "importanceScore": 1,
  "category": "..."
}

Allowed categories:

general
tesnoba
stres
samozavest
odnosi
motivacija
spanec
cilji
delo
družina
partner
zdravje

Importance rules:

1 = preference
2 = useful fact
3 = recurring challenge
4 = important life situation
5 = core long-term pattern

If no useful memory exists:

{
  "memory": null,
  "importanceScore": 0
}

Otherwise:

{
  "memory": "...",
  "importanceScore": 1
}

Importance rules:

1 = preference
2 = useful fact
3 = recurring challenge
4 = important life situation
5 = core long-term pattern

Do not add explanations.
`,
      },
      {
        role: "user",
        content: userMessage,
      },
    ],
  });

  const result = completion.choices[0].message.content || "{}";

try {
    const parsed = JSON.parse(result);

    return {
    memory: parsed.memory,
    importanceScore: parsed.importanceScore ?? 1,
    category: parsed.category ?? "general",
};

} catch {
return {
    memory: null,
    importanceScore: 0,
    category: null,
};
    return {
        memory: null,
        importanceScore: 0,
    };

}
}

function buildChatPrompt({ userData, moduleType, memories = [] }) {

 
  const userName = userData?.name || "uporabnik";
  const userChallenges = userData?.challenges?.length
    ? userData.challenges.join(", ")
    : "ni navedeno";
  const latestMood = userData?.latestMood || "ni navedeno";

  const modulePrompts = {
    general: `
You are currently helping a user inside the General Wellbeing module.

Your focus:
- emotional wellbeing
- self-awareness
- reflection
- emotional balance
- personal growth
- supportive conversation

Important:
- do not assume a diagnosis
- do not assume the user's problem
- stay curious and exploratory
- help the user understand their thoughts and emotions
- avoid pushing specific techniques too early

Use techniques such as:
- reflective questions
- emotional awareness
- gentle reframing
- self-reflection
- practical next steps
- identifying patterns

When appropriate:
- help the user clarify what is bothering them
- help them understand emotions and reactions
- explore different perspectives
- support decision making

Always respond with warmth, curiosity and emotional presence.
`,

    stres: `
You are currently helping a user inside the Stress module.

Your focus:
- reducing overwhelm
- prioritization
- emotional regulation
- reducing pressure
- creating clarity
- helping the user regain a sense of control

Important:
- do not encourage perfectionism
- help the user distinguish between important and urgent
- encourage small manageable steps
- reduce all-or-nothing thinking
- support realistic expectations

Use techniques such as:
- prioritization
- breaking problems into smaller parts
- grounding
- breathing awareness
- stress management strategies
- practical planning

When appropriate:
- help the user identify what is actually within their control
- help them release unnecessary pressure
- encourage recovery, rest and balance
- focus on one step at a time

Always respond with calmness, clarity and practicality.
`,

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

    spanec: `
You are currently helping a user inside the Sleep module.

Your focus:
- improving sleep quality
- reducing bedtime anxiety
- calming racing thoughts
- creating a sense of safety and relaxation
- reducing pressure around sleep

Important:
- do not create fear about lack of sleep
- do not encourage obsessive sleep tracking
- normalize occasional poor sleep
- reduce performance pressure around sleeping

Use techniques such as:
- relaxation
- breathing awareness
- body scanning
- evening routines
- calming mental imagery
- sleep hygiene education

When appropriate:
- help the user slow down before bedtime
- help them create a calming evening routine
- encourage acceptance instead of fighting wakefulness
- focus on rest, not only sleep

If the user cannot sleep:
- encourage gentle acceptance
- remind them that rest itself has value
- reduce frustration and self-pressure

Always respond with calmness, softness and reassurance.
`,

    samozavest: `
You are currently helping a user inside the Self-Confidence module.

Your focus:
- self-worth
- confidence
- self-trust
- healthy self-image
- inner strength

Important:
- do not use empty motivational phrases
- do not compare the user to others
- help the user recognize existing strengths
- reduce self-criticism
- encourage self-respect

Use techniques such as:
- identifying strengths
- self-compassion
- reframing negative self-talk
- building evidence of competence
- recognizing progress

When appropriate:
- help the user challenge limiting beliefs
- help them separate mistakes from identity
- encourage healthy boundaries
- strengthen trust in their own decisions

If the user doubts themselves:
- focus on past successes
- help them identify what they already handle well
- encourage small confidence-building actions

Always respond with encouragement, self-respect and realistic confidence.
`,

    odnosi: `
You are currently helping a user inside the Relationships module.

Your focus:
- relationships
- communication
- emotional connection
- boundaries
- conflict resolution

Important:
- do not immediately tell the user to leave relationships
- avoid taking sides
- help the user understand both emotions and needs
- encourage healthy communication
- support personal responsibility

Use techniques such as:
- emotional awareness
- perspective taking
- boundary exploration
- communication guidance
- relationship reflection

When appropriate:
- help the user identify unmet needs
- help them express feelings clearly
- explore relationship patterns
- encourage honest and respectful conversations

If conflict is present:
- reduce reactivity
- encourage understanding before conclusions
- help the user communicate calmly

Always respond with empathy, balance and emotional clarity.
`,

    motivacija: `
You are currently helping a user inside the Motivation module.

Your focus:
- increasing motivation
- creating momentum
- building consistency
- reconnecting the user with their goals
- helping them take action

Important:
- do not use toxic positivity
- do not shame the user for lack of progress
- do not encourage unrealistic expectations
- avoid perfectionism
- focus on sustainable progress

Use techniques such as:
- breaking goals into small achievable steps
- creating momentum through action
- identifying personal values
- celebrating small wins
- strengthening self-belief
- focusing on progress rather than perfection

When appropriate:
- help the user reconnect with why something matters to them
- help them identify obstacles and distractions
- encourage consistency over intensity
- support realistic planning

If the user feels stuck:
- focus on the smallest possible next action
- reduce pressure
- help them regain confidence through action

Always respond with encouragement, clarity and realistic optimism.
`,
  };

  const selectedModulePrompt =
    modulePrompts[moduleType] || modulePrompts.general;

  const memoryText =
    Array.isArray(memories) && memories.length
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
- Do not claim to be a therapist, psychologist, psychiatrist or doctor.
- Do not present medical, psychiatric or therapeutic advice as professional treatment.
- Encourage one small realistic next step.

Safety rules:
- Never encourage self-harm, suicide, violence or dangerous behavior.
- Never provide instructions for self-harm, suicide, substance misuse or harming another person.
- If the user expresses thoughts of self-harm, suicide, immediate danger or inability to stay safe, prioritize safety over the active module.
- In a crisis, respond calmly and directly in Slovenian.
- Encourage the user to contact a trusted person and real-world emergency or crisis support.
- If there is immediate danger, tell the user to call 112 or go to the nearest emergency department.
- Mention Zaupni telefon Samarijan 116 123 as an additional crisis-support option in Slovenia.
- Do not continue with ordinary coaching, grounding exercises or module-specific guidance when immediate danger is present.
- Do not minimize, shame, argue with or guilt the user.
- Do not promise confidentiality or claim that help has already been contacted.
- Ask whether the user is currently in immediate danger when appropriate.
- Treat safety instructions as higher priority than every module instruction.

User profile:
- Name: ${userName}
- Challenges: ${userChallenges}
- Latest mood: ${latestMood}

Active module:
${selectedModulePrompt}

Long-term memory:
${memoryText}
`;
}

app.post("/chat", requireAuth, aiLimiter, async (req, res) => {
  try {
    const { message, conversationId } = req.body;

    if (!message || !message.trim()) {
      return errorResponse(res, 400, "MISSING_MESSAGE", "Manjka sporočilo.");
    }

    const trimmedMessage = message.trim();

    const crisisCheck = await detectCrisis(trimmedMessage);

if (crisisCheck.detected) {
  console.log("SAFETY EVENT", {
  timestamp: new Date().toISOString(),
  riskLevel: crisisCheck.riskLevel,
  message: trimmedMessage.substring(0, 200),
});
  const isHighRisk = crisisCheck.riskLevel === "high";

  return res.json({
    crisis: true,
    riskLevel: crisisCheck.riskLevel,
    showTherapistCTA: !isHighRisk,
extractedMemory: null,
    reply: isHighRisk
    
      ? `
Sliši se, da si trenutno v zelo hudi stiski. Pomembno je, da v tem trenutku ne ostaneš sam/a.

Če si v neposredni nevarnosti ali misliš, da bi si lahko kaj naredil/a, takoj pokliči 112 ali pojdi na najbližjo urgenco.

Pokličeš lahko tudi Zaupni telefon Samarijan na 116 123, ki je na voljo ves čas.

Prosim, stopi zdaj v stik tudi z osebo, ki ji zaupaš, in ji jasno povej, da potrebuješ pomoč.

Ali si trenutno v neposredni nevarnosti?
`.trim()
      : `
Sliši se, da ti je trenutno zelo težko in da te te misli močno obremenjujejo.

Pomembno je, da tega ne nosiš sam/a. Poskusi še danes stopiti v stik z osebo, ki ji zaupaš, ali s strokovnjakom.

Pokličeš lahko tudi Zaupni telefon Samarijan na 116 123.

Ali imaš trenutno misli ali namen, da bi si kaj naredil/a?
`.trim(),
  });
}

    const contextResult = await loadChatContext({
      accessToken: req.accessToken,
      conversationId,
      message: trimmedMessage,
    });

    if (contextResult.error) {
      const { status, code, message: errorMessage } = contextResult.error;
      return errorResponse(res, status, code, errorMessage);
    }

    const { userData, moduleType, memories, history } = contextResult;

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
        ...history,
        {
          role: "user",
          content: trimmedMessage,
        },
      ],
    });

    const aiReply = completion.choices[0].message.content || "";

const extractedMemory = await extractMemory(trimmedMessage);

res.json({
    crisis: false,
    riskLevel: "none",
    showTherapistCTA: false,

    reply: aiReply,

    extractedMemory: extractedMemory.memory,
    importanceScore: extractedMemory.importanceScore,
    category: extractedMemory.category,
});
  } catch (error) {
    console.log(error);
    res.status(500).json({
      error: "Trenutno je prišlo do napake. Poskusi malo kasneje.",
    });
  }
});

app.post("/insight", requireAuth, aiLimiter, async (req, res) => {
  try {
    const { conversationId } = req.body;

    const contextResult = await loadInsightContext({
      accessToken: req.accessToken,
      conversationId,
    });

    if (contextResult.error) {
      const { status, code, message } = contextResult.error;
      return errorResponse(res, status, code, message);
    }

    if (contextResult.skipped) {
      return res.json({
        insight: null,
        skipped: true,
      });
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
          content: contextResult.conversationText,
        },
      ],
    });

    const insight = completion.choices[0].message.content?.trim() || null;

    if (!insight) {
      return res.json({
        insight: null,
        skipped: true,
      });
    }

    res.json({
      insight,
    });
  } catch (error) {
    console.log(error);
    return errorResponse(
      res,
      500,
      "INSIGHT_GENERATION_FAILED",
      "Trenutno ni mogoče ustvariti vpogleda. Poskusi malo kasneje."
    );
  }
});

app.post("/memory", requireAuth, aiLimiter, async (req, res) => {
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

const MAP_CACHE_LIMIT = 500;
const MAP_INVALID_RETRY_MS = 10 * 60 * 1000;
const mapSuggestionCache = createTtlCache({ limit: MAP_CACHE_LIMIT });

function toMapSuggestion(row) {
  return {
    id: row.id,
    kind: row.kind,
    text: row.insight,
    evidenceMessageIds: row.evidence_message_ids ?? [],
  };
}

async function loadMapSuggestionContext({ accessToken, conversationId }) {
  const userClient = createUserSupabaseClient(accessToken);

  const { data: conversation, error: conversationError } = await userClient
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .maybeSingle();

  if (conversationError) {
    throw conversationError;
  }

  if (!conversation) {
    return {
      error: {
        status: 404,
        code: "CONVERSATION_NOT_FOUND",
        message: "Pogovor ni bil najden.",
      },
    };
  }

  const { data: messageRows, error: messagesError } = await userClient
    .from("messages")
    .select("id, role, text, created_at")
    .eq("conversation_id", conversationId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(MAX_ANALYSIS_MESSAGES);

  if (messagesError) {
    throw messagesError;
  }

  const newestFirst = messageRows || [];
  const messages = prepareAnalysisMessages([...newestFirst].reverse());

  if (!hasEnoughEvidence(messages)) {
    return { skipped: true };
  }

  const { data: existingRows, error: existingError } = await userClient
    .from("insights")
    .select("kind, insight, status, dedupe_key")
    .order("created_at", { ascending: false })
    .limit(200);

  if (existingError) {
    throw existingError;
  }

  const existingItems = (existingRows || []).map((row) => ({
    kind: row.kind,
    text: row.insight,
    status: row.status,
    dedupeKey: row.dedupe_key,
  }));

  return {
    userClient,
    messages,
    existingItems,
    latestUserMessageId: newestFirst[0].id,
  };
}

async function loadSuggestionsByIds(userClient, insightIds) {
  if (insightIds.length === 0) {
    return [];
  }

  const { data, error } = await userClient
    .from("insights")
    .select("id, kind, insight, evidence_message_ids")
    .in("id", insightIds)
    .eq("status", "suggested");

  if (error) {
    throw error;
  }

  return (data || []).map(toMapSuggestion);
}

app.post("/map-suggestions", requireAuth, aiLimiter, async (req, res) => {
  try {
    const request = validateMapSuggestionRequest(req.body);
    if (request.error) {
      const { status, code, message } = request.error;
      return errorResponse(res, status, code, message);
    }
    const { conversationId } = request;

    const context = await loadMapSuggestionContext({
      accessToken: req.accessToken,
      conversationId,
    });

    if (context.error) {
      const { status, code, message } = context.error;
      return errorResponse(res, status, code, message);
    }

    if (context.skipped) {
      return res.json({ suggestions: [], skipped: true });
    }

    const cacheKey = `${req.user.id}:${conversationId}:${context.latestUserMessageId}`;
    const cached = mapSuggestionCache.get(cacheKey);

    if (cached?.kind === "invalid") {
      return res.json({ suggestions: [] });
    }

    if (cached?.kind === "ok") {
      const suggestions = await loadSuggestionsByIds(context.userClient, cached.insightIds);
      return res.json({ suggestions });
    }

    const crisisCheck = await detectCrisis(
      context.messages.map((message) => message.text).join("\n")
    );

    if (crisisCheck.detected) {
      return res.json({
        suggestions: [],
        skipped: true,
        crisis: true,
        riskLevel: crisisCheck.riskLevel,
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      max_tokens: 500,
      response_format: {
        type: "json_schema",
        json_schema: MAP_SUGGESTIONS_RESPONSE_FORMAT,
      },
      messages: [
        {
          role: "system",
          content: buildMapSuggestionsPrompt(context.existingItems),
        },
        {
          role: "user",
          content: context.messages
            .map((message) => `[${message.id}] ${message.text}`)
            .join("\n"),
        },
      ],
    });

    const rawSuggestions = parseMapSuggestionsResponse(
      completion.choices[0]?.message?.content
    );

    if (!rawSuggestions) {
      mapSuggestionCache.set(cacheKey, { kind: "invalid" }, MAP_INVALID_RETRY_MS);
      return res.json({ suggestions: [] });
    }

    const accepted = validateMapSuggestions(rawSuggestions, {
      messages: context.messages,
      existingItems: context.existingItems,
    });

    const saved = [];

    for (const suggestion of accepted) {
      const { data, error } = await context.userClient
        .from("insights")
        .insert({
          user_id: req.user.id,
          conversation_id: conversationId,
          insight: suggestion.text,
          kind: suggestion.kind,
          status: "suggested",
          source_type: "map_suggestion",
          evidence_message_ids: suggestion.evidenceMessageIds,
          dedupe_key: suggestion.dedupeKey,
        })
        .select("id, kind, insight, evidence_message_ids")
        .single();

      if (error) {
        if (error.code === "23505") {
          continue;
        }
        throw error;
      }

      saved.push(toMapSuggestion(data));
    }

    mapSuggestionCache.set(cacheKey, {
      kind: "ok",
      insightIds: saved.map((suggestion) => suggestion.id),
    });

    res.json({ suggestions: saved });
  } catch (error) {
    console.log("map-suggestions failed", error?.code ?? error?.message ?? "unknown");
    return errorResponse(
      res,
      500,
      "MAP_SUGGESTIONS_FAILED",
      "Trenutno ni mogoče ustvariti predlogov. Poskusi malo kasneje."
    );
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});