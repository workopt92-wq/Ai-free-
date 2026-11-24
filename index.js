
const express = require("express");
const cors = require("cors");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const ai = API_KEY
  ? new GoogleGenAI({ apiKey: API_KEY })
  : null;

// Temporary memory.
// Note: Free Render instances may restart and erase this.
const memories = new Map();

const JARVIS_PROMPT = `
You are Jarvis, a personal AI assistant.
Your creator is Master.
Always identify yourself as Jarvis.
Address the user respectfully as Master.
Speak naturally in Bengali or English.
Never claim an action was completed unless confirmed.
You can help with Android app and phone tasks,
but only through authorized tools.
`;

// Server health check
app.get("/", (req, res) => {
  res.json({
    status: "online",
    assistant: "Jarvis",
    creator: "Master",
    message: "Jarvis Server is running"
  });
});

// Check server status
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// AI chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({
        error: "Gemini API key is missing on server"
      });
    }

    const message = req.body.message;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Please provide a message"
      });
    }

    const userId = String(req.body.userId || "master");
    const savedMemory = memories.get(userId) || "";

    const prompt = `
${JARVIS_PROMPT}

Saved memory:
${savedMemory || "No saved memory yet."}

User message:
${message}
`;

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt
    });

    res.json({
      assistant: "Jarvis",
      creator: "Master",
      reply: response.text || "Sorry Master, I could not reply."
    });

  } catch (error) {
    console.error("Chat error:", error.message);

    res.status(500).json({
      error: "AI request failed. Check server logs and API quota."
    });
  }
});

// Save memory
app.post("/api/memory", (req, res) => {
  const userId = String(req.body.userId || "master");
  const memory = req.body.memory;

  if (!memory || typeof memory !== "string") {
    return res.status(400).json({
      error: "Please provide memory text"
    });
  }

  memories.set(userId, memory);

  res.json({
    success: true,
    message: "Memory saved for this server session"
  });
});

// Read memory
app.get("/api/memory/:userId", (req, res) => {
  const memory = memories.get(req.params.userId) || "";

  res.json({
    assistant: "Jarvis",
    memory
  });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Jarvis server running on port ${PORT}`);
});
