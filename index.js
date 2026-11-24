const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const { WebSocket, WebSocketServer } = require("ws");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const LIVE_MODEL = process.env.LIVE_MODEL || "models/gemini-3.1-flash-live-preview";
const CLIENT_TOKEN = process.env.SUPI_CLIENT_TOKEN || "";
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 20);
const MAX_SESSION_MS = Number(process.env.MAX_SESSION_MINUTES || 10) * 60_000;
const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;
const memories = new Map();
const activeSessions = new Set();
const sessionsByIp = new Map();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "microphone=(self)");
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
});

const SUPI_PROMPT = `
You are Supi, a friendly real-time AI voice assistant. Speak naturally in Bengali or English and reply in the user's language. Your creator is Master. Always identify yourself as Supi. Never identify yourself as Rox, Jarvis, or Rohan. Never claim an action was completed unless confirmed. You can help with Android app and phone tasks, but only through authorized tools.
`;

// Hosted Supi app and server status.
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/health", (_req, res) => res.json({ ok: true, assistant: "Supi", creator: "Master", activeSessions: activeSessions.size }));
app.get("/healthz", (_req, res) => res.json({ ok: true, service: "supi-live", activeSessions: activeSessions.size }));
app.get("/api/status", (_req, res) => res.json({ online: true, assistant: "Supi", creator: "Master", liveVoice: Boolean(API_KEY) }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

// Text chat remains available alongside the Live voice session.
app.post("/api/chat", async (req, res) => {
  try {
    if (!ai) return res.status(500).json({ error: "Gemini API key is missing on server" });
    const message = req.body.message;
    if (!message || typeof message !== "string") return res.status(400).json({ error: "Please provide a message" });
    const userId = String(req.body.userId || "master").slice(0, 100);
    const savedMemory = memories.get(userId) || "";
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: `${SUPI_PROMPT}\nSaved memory:\n${savedMemory || "No saved memory yet."}\nUser message:\n${message}`
    });
    res.json({ assistant: "Supi", creator: "Master", reply: response.text || "দুঃখিত, এখন উত্তর দিতে পারছি না।" });
  } catch (error) {
    console.error("Chat error:", error.message);
    res.status(500).json({ error: "AI request failed. Check server logs and API quota." });
  }
});
app.post("/api/memory", (req, res) => {
  const userId = String(req.body.userId || "master").slice(0, 100);
  const memory = req.body.memory;
  if (!memory || typeof memory !== "string") return res.status(400).json({ error: "Please provide memory text" });
  memories.set(userId, memory.slice(0, 20_000));
  res.json({ success: true, message: "Memory saved for this server session" });
});
app.get("/api/memory/:userId", (req, res) => {
  res.json({ assistant: "Supi", memory: memories.get(req.params.userId) || "" });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/live" || !API_KEY) return socket.destroy();
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return socket.destroy(); }
    catch { return socket.destroy(); }
  }
  if (CLIENT_TOKEN && url.searchParams.get("token") !== CLIENT_TOKEN) return socket.destroy();
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (activeSessions.size >= MAX_SESSIONS || (sessionsByIp.get(ip) || 0) >= 3) return socket.destroy();
  wss.handleUpgrade(req, socket, head, client => wss.emit("connection", client, ip));
});

wss.on("connection", (client, ip) => {
  activeSessions.add(client);
  sessionsByIp.set(ip, (sessionsByIp.get(ip) || 0) + 1);
  const upstream = new WebSocket(
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
    { headers: { "x-goog-api-key": API_KEY }, maxPayload: 1024 * 1024, perMessageDeflate: false }
  );
  let hasSetup = false;
  let released = false;
  let windowStart = Date.now();
  let messages = 0;
  const pending = [];
  const cleanup = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    activeSessions.delete(client);
    const remaining = Math.max(0, (sessionsByIp.get(ip) || 1) - 1);
    if (remaining) sessionsByIp.set(ip, remaining); else sessionsByIp.delete(ip);
  };
  const closeBoth = (code = 1000, reason = "Session closed") => {
    if (client.readyState < WebSocket.CLOSING) client.close(code, reason.slice(0, 120));
    if (upstream.readyState < WebSocket.CLOSING) upstream.close(code, reason.slice(0, 120));
  };
  const timer = setTimeout(() => closeBoth(4008, "Session time limit reached"), MAX_SESSION_MS);
  client.on("message", (data, isBinary) => {
    if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); messages = 0; }
    if (++messages > 120) return closeBoth(1008, "Message rate limit exceeded");
    if (isBinary) return;
    try {
      const message = JSON.parse(data.toString());
      if (message.setup) {
        if (hasSetup) return closeBoth(1008, "Only one setup is allowed");
        hasSetup = true;
        message.setup.model = LIVE_MODEL;
        message.setup.systemInstruction = { parts: [{ text: SUPI_PROMPT }] };
      } else if (!hasSetup) {
        return closeBoth(1008, "Send setup first");
      }
      const outgoing = JSON.stringify(message);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(outgoing);
      else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 10) pending.push(outgoing);
      else closeBoth(1011, "Live AI upstream unavailable");
    } catch {
      closeBoth(1007, "Invalid message");
    }
  });
  upstream.on("open", () => {
    while (pending.length && upstream.readyState === WebSocket.OPEN) upstream.send(pending.shift());
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("error", () => closeBoth(1011, "Live AI upstream unavailable"));
  upstream.on("close", (code, reason) => {
    const safeCode = [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code) || (code >= 3000 && code <= 4999) ? code : 1011;
    if (client.readyState < WebSocket.CLOSING) client.close(safeCode, reason.toString().slice(0, 120));
    cleanup();
  });
  client.on("close", () => { if (upstream.readyState < WebSocket.CLOSING) upstream.close(); cleanup(); });
  client.on("error", () => { if (upstream.readyState < WebSocket.CLOSING) upstream.close(); cleanup(); });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Supi server listening on port ${PORT}`));
