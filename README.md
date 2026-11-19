# Atoms Voice Lab

A small, working voice agent built on the [Smallest.ai Atoms API](https://docs.smallest.ai/api-reference/voice-agents/realtime-agent/realtime-agent) — with a real UI, live transcripts, barge-in, a client tool, and latency numbers.

It is an implementation of the ideas in [“How to Build an AI Voice Agent Using Atoms API”](https://smallest.ai/blog/how-to-build-an-ai-voice-agent-using-atoms-api), corrected to use the **real production API** rather than the blog's illustrative endpoints.

![No build step](https://img.shields.io/badge/build-none-4fd1c5) ![Node 18+](https://img.shields.io/badge/node-%E2%89%A518-4fd1c5)

---

## Run it

```bash
# 1. Put your key in .env (copy .env.example)
#    SMALLEST_API_KEY=sk_...

# 2. Start the server — no npm install, no dependencies
npm start

# 3. Open http://localhost:3000 and allow the microphone
```

Requirements: **Node 18+**, a Smallest.ai API key, and a microphone. Chrome, Edge, or Firefox on `localhost` (browsers only expose the mic on a secure context).

> The UI creates **real agents in your workspace** when you use “Create a new agent”. They appear in the dashboard, can be tested there, and can be archived there. Nothing is created unless you submit that form.

---

## What you get

| | |
|---|---|
| **Agent panel** | Lists existing workspace agents, shows the resolved prompt and tools, and can create + publish a new agent (prompt, first message, Lightning voice, optional client tool). |
| **Conversation stage** | Start/end call, mute, typed messages, streaming transcript bubbles, an orb that reacts to mic/agent audio, and a live visualizer. |
| **Wire inspector** | Every WebSocket frame (`input_audio_buffer.append`, `output_audio.delta`, `transcript.delta`, `interruption`, `function_call`, …) with timestamps and byte counts. |
| **Metrics** | Reply TTFB (user transcript → first audio byte), agent turn duration, mic frames, and call id. |
| **Call history** | Every finished call, read back from Atoms: transcript, post-call summary, latency, cost, status, and the recording. Filter by agent or search a call id. |
| **Built-in tool** | `get_order_status` runs in the browser and calls a fake order API on this server, so you can see the client-tool round trip without exposing a public URL. |

---

## Where are my call logs?

Click **Call history** in the top bar. It is a thin viewer over the same records the Smallest dashboard shows:

```
GET https://api.smallest.ai/atoms/v1/conversation
      → callId, status, duration, cost, agent, post-call summary, latency
GET https://api.smallest.ai/atoms/v1/analytics/conversation-details/:callId
      → full transcript + raw event stream
GET https://api.smallest.ai/atoms/v1/recordings/:callId?channel=mono
      → short-lived (15 min) presigned WAV URL
```

What you can do there:

- **Read what was said** — the transcript is stored by Atoms, not by this app, so it survives reloads and works for phone calls too.
- **See the summary** — `postCallAnalytics.summary` condenses the call (e.g. “Steve asked to cancel his policy…”).
- **Check latency** — per-call average/median/min/max and turn count from `turnLatencyMetrics`.
- **Play the recording** — the server resolves the presigned URL on demand; the link is never stored in the page.
- **Inspect raw data** — expand “Events & raw data” for the normalized log + detail JSON.
- **Filter** — by agent, or search by call id. Active calls show a live transcript and become playable when they end.

The list is fetched with the default `updatedAt` sort (fast, indexed). Call variables passed at `register-call` are **not** part of the stored log — only the transcript and post-call analytics are.


---

## Architecture

```
┌──────────────────────────── browser (public/app.js) ────────────────────────────┐
│  mic ── AudioWorklet ── PCM16 24 kHz ─┐                    ┌─ AudioContext ← PCM │
│  transcript / metrics / wire log      │                    │                     │
│                                       ▼                    ▲                     │
│                        wss://api.smallest.ai/atoms/v1/agent/connect?token=wct_…  │
└───────────────────────────────────────┬────────────────────┴─────────────────────┘
                                        │
                                        │        Atoms pipeline (hosted)
                                        │   Pulse STT → Electron LLM → Lightning TTS
                                        │
┌───────────────────────────────────────▼─────────────────────────────────────────┐
│  node server.js                                                                  │
│  • holds SMALLEST_API_KEY (never sent to the browser)                            │
│  • POST /conversation/register-call  → 30 s single-use token                     │
│  • POST /agent + branch draft + publish (agent creation)                         │
│  • GET  /api/demo/orders/:id (fake CRM the browser tool calls)                   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Why a server token?

A raw `sk_…` key in the browser would let anyone spend your credits. The browser asks this server for a call, the server calls `POST /atoms/v1/conversation/register-call`, and returns a `wct_…` token that is **single-use and expires in 30 seconds**. That token is the only credential in the page.

---

## The five flows, in real API terms

### 1. Create an agent

`POST /agent` creates only a shell. Prompt, first message, voice and tools live on a **branch draft**, which must be published and pass a security scan.

```
POST /agent                                → { data: agentId }
GET  /agent/:id/branches                    → main branch (+ headRevisionNumber)
PUT  /agent/:id/branches/:id/draft          → globalPrompt, firstMessage,
                                               synthesizer, language,
                                               singlePromptConfig { prompt, tools }
POST /agent/:id/branches/:id/draft/publish  → 202 { state: "scanning" }
GET  /agent/:id/branches/:id/revisions      → poll until published
```

That is what `createAgent()` in [`server.js`](server.js) does. A minimal create with only `name` works, but then the agent answers with the default Smallest prompt.

### 2. Start a call

```js
POST https://api.smallest.ai/atoms/v1/conversation/register-call
{ agent_id, mode: "webcall", input_audio_format: "pcm_24000", output_audio_format: "pcm_24000" }

→ { access_token: "wct_…", expires_in: 30, sample_rate: 24000, … }

new WebSocket(`wss://api.smallest.ai/atoms/v1/agent/connect?token=${token}`)
```

Do **not** also pass `agent_id` on the socket URL when using a token — it is baked into the token.

### 3. Stream audio

The socket is JSON, not raw bytes. Audio is base64 PCM16.

```js
↑ { type: "input_audio_buffer.append", audio: "<base64 PCM16>" }   // 20 ms frames
↓ { type: "output_audio.delta",        audio: "<base64 PCM16>" }
↓ { type: "transcript.delta",          role: "assistant", text: "…" } // cumulative
↓ { type: "transcript",                role: "user",      text: "…" } // final
```

Server-side VAD handles turn boundaries; this client never sends `input_audio_buffer.commit`. Playback is scheduled on an `AudioContext` so the first chunk plays immediately.

### 4. Barge-in

When the server detects the user speaking over the agent, it sends:

```json
{ "type": "interruption" }
```

The client must stop every queued `AudioBufferSourceNode` and reset its playback clock — see `stopPlayback()` in `public/app.js`. The agent's `allowInterruptions` setting is enabled when this demo creates an agent.

### 5. Client tools

The demo agent gets a `client_tool` named `get_order_status`. Atoms sends the call to the browser rather than to a public webhook:

```json
↓ { "type": "function_call", "call_id": "…", "name": "get_order_status",
    "arguments": "{\"order_id\":\"ORD-9821\"}" }
```

`public/app.js` calls `GET /api/demo/orders/ORD-9821` (fake data, 350 ms delay to show off the filler phrase), then replies:

```json
↑ { "type": "function_call.result", "call_id": "…",
    "output": "{\"status\":\"Out for delivery\",\"eta\":\"today by 7:00 PM\"}" }
```

Try: **“What’s the status of order ORD-9821?”** · **ORD-1042** · **ORD-7788** · or an unknown id to hear the failure path.

---

## The blog vs. this demo

The post is a useful mental model, but its code is not runnable. These are the differences that matter:

| Blog | Real Atoms API |
|---|---|
| `POST https://atoms.smallest.ai/v1/agents` | `POST https://api.smallest.ai/atoms/v1/agent` (singular, different host) |
| `wss://atoms.smallest.ai/v1/agents/{id}/stream` | `wss://api.smallest.ai/atoms/v1/agent/connect?token=…` |
| `{ voice_id, model, temperature, max_tokens }` on create | `synthesizer.voiceConfig.{model,voiceId}`, `language`, `slmModel`; prompt/tools go in a branch draft (`singlePromptConfig`) |
| Raw PCM chunks over the socket | JSON frames: `input_audio_buffer.append` / `output_audio.delta`, base64 audio |
| `{ "type": "interrupt" }` | `{ "type": "interruption" }` (server → client) |
| `{ "type": "tool_call" }` / `tool_result` | `{ "type": "function_call" }` / `function_call.result`, with `call_id` and **JSON-encoded strings** |
| “TTFB under 500 ms” as a target | Measured live in the inspector; it varies by region, voice and prompt length |

The one thing the blog gets right: one hosted pipeline (Pulse → Electron → Lightning) is much less work than wiring three providers, and the event contract is small.

---

## Files

```
server.js              zero-dependency HTTP server + Atoms API calls + fake order API
public/index.html      layout and the explainer cards
public/styles.css      all styling (no build step, no frameworks)
public/app.js          WebSocket client, audio capture/playback, transcript, wire log
public/pcm-worklet.js  AudioWorklet: 20 ms Float32 frames from the microphone
.env.example           copy to .env and add your key
```

Smallest AI skills were installed with `npx skills add smallest-inc/skills` into `.agents/skills/` (Atoms agent work uses the API docs; the bundled skills cover Lightning TTS, Pulse STT, Electron LLM and Hydra S2S).

---

## A 2-minute demo script

1. Pick **“Policy Review & Upsell”** (or create a store agent).
2. **Start call** → allow the mic → listen to the greeting.
3. Say **“What’s the status of order ORD-9821?”**
   Watch the `function_call` → local API → `function_call.result` sequence and the agent speak the result.
4. Ask a longer question, then **talk over the agent**. The `interruption` frame stops playback mid-sentence.
5. Read **Reply TTFB** in the inspector. The first turn includes connection/setup; later turns are the honest number.
6. Type a message in the text bar — the reply still comes back as audio.
7. **End** the call, then open **Call history**: transcript, summary, latency, cost and the recording are all saved by Atoms.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Missing API key` on start | `.env` must contain `SMALLEST_API_KEY=sk_…` (or `API_Key=…`). Restart the server. |
| `401` in the Wire panel | Key is invalid/revoked, or the agent id does not belong to your org. |
| Mic button does nothing | Browsers require `http://localhost` or HTTPS. `http://<LAN-IP>:3000` will fail. |
| “Call closed (1006)” | Network drop, or the token was used twice. Tokens are single-use; start a new call. |
| Agent creation times out | Publishing runs a security scan; it can take ~30 s. The agent is still created — check **Agents** in the dashboard. |
| Agent ignores the order tool | The tool is a **client tool**, so it only runs on webcall sessions (not phone calls). Confirm the prompt or tool description was published. |
| No audio but transcripts work | Check the OS output device and that the tab is not muted. Echo cancellation needs headphones for the cleanest barge-in test. |

---

## Notes

- No dependencies, no build. `npm install` is not needed.
- `GET /api/voices` proxies the Lightning v3.1 Pro catalog and falls back to a small built-in list if the catalog is unavailable.
- Audio is captured at 24 kHz when the browser allows it and resampled otherwise; the socket always declares `pcm_24000`.
- This is a demo, not a production client: no reconnect/backoff, no persistence, no per-user auth, and the fake order database is in memory.
