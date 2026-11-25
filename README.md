# Supi Live AI Server

Supi's hosted web UI and live voice relay. Supi identifies itself as Supi and names উৎস (Uts) as its creator. Text questions typed while the live session starts are queued and sent when setup completes. The Gemini API key remains in Render's server environment and is never sent to the app. Existing text chat and memory routes are retained with Supi identity.

## Render environment variables

Keep the current `GEMINI_API_KEY`. Optional settings:

- `GEMINI_MODEL` — text chat model (existing setting).
- `LIVE_MODEL` — defaults to `models/gemini-3.8-live`; a legacy 3.1 Flash Live value is upgraded to this model.
- `SUPI_CLIENT_TOKEN` — optional shared app gate; if set, enter it in Supi settings.
- `MAX_SESSIONS` — defaults to 20.
- `MAX_SESSION_MINUTES` — defaults to 10.
- `PORT` — assigned by Render.

Render can deploy this repository automatically after changes reach the connected branch. Health checks are available at `/health` and `/healthz`; the WebSocket endpoint is `/live`.
