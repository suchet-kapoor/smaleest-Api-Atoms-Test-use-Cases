# Smallest.ai Atoms Voice Lab

A browser-based voice-agent lab for exploring the [Smallest.ai Atoms API](https://docs.smallest.ai/api-reference/voice-agents/realtime-agent/realtime-agent). It demonstrates the production agent lifecycle, realtime two-way PCM audio, barge-in, client tools, call history, recordings, transcripts, and latency inspection—without exposing the API key in the browser.

The project is implemented with Node.js and plain HTML/CSS/JavaScript, with no frontend build step or third-party runtime dependencies.

## Features

- **Agent discovery:** list the agents in your Smallest workspace and inspect their prompt, voice, tools, language, and interruption settings.
- **Agent creation:** create an agent shell, configure the Main branch draft, publish a revision, and wait for the security scan to complete.
- **Realtime browser calls:** stream 24 kHz PCM16 microphone audio over WebSocket and play streamed agent audio in real time.
- **Text-to-agent input:** send typed messages through the same realtime session.
- **Barge-in:** interrupt the agent while it is speaking; queued audio playback stops when the server detects an interruption.
- **Client tool demo:** ask for an order status and let the agent call `get_order_status`, handled locally through `/api/demo/orders/:orderId`.
- **Per-call variables:** pass a JSON object when registering a call.
- **Call history:** browse workspace call records, filter by agent, search call IDs, view transcripts and summaries, inspect turn latency, and open recordings.
- **Protocol inspector:** watch WebSocket frames and response metrics, including reply TTFB and agent turn duration.

## How it works

```text
Browser (microphone/text)
  │  HTTP for agents, call tokens, history, and tools
  ▼
Node.js server (server.js)
  │  keeps SMALLEST_API_KEY on the server
  ├── Atoms REST API
  └── Lightning voice catalog API
  │
  ▼
Atoms realtime WebSocket
  input_audio_buffer.append / input_text.send / function_call.result
  ◄── output audio, transcripts, interruptions, session events
```

The browser never receives your secret API key. The server registers a web call and returns a short-lived `wct_…` access token, which the browser uses to open the Atoms realtime WebSocket.

## Prerequisites

- Node.js 18 or newer
- A Smallest.ai account and API key
- A browser that supports `getUserMedia`, `AudioContext`, and `AudioWorklet`
- A microphone for voice calls

Chrome or Edge on desktop is recommended.

## Setup

### 1. Clone and enter the project

```powershell
cd C:\Users\Suchet\Desktop\Ring-Hackathon\Smallest-Voice\smaleest-Api-Atoms-Test-use-Cases
```

### 2. Configure the API key

Copy the example environment file:

```powershell
Copy-Item .env.example .env
```

Set your key in `.env`:

```dotenv
SMALLEST_API_KEY=sk_your_key_here

# Optional
PORT=3000
HOST=127.0.0.1
```

You can obtain or manage API keys from the [Smallest.ai dashboard](https://app.smallest.ai/dashboard/api-keys). Never commit `.env` or add the API key to browser code.

### 3. Start the app

```powershell
npm start
```

For automatic Node.js restarts during development:

```powershell
npm run dev
```

Open <http://localhost:3000>.

Browser microphone access is secure on `localhost`; use `localhost`, not `127.0.0.1`, when testing microphone permissions.

## Using the demo

1. Wait for the agent list and voice catalog to load.
2. Select an existing workspace agent, or open **Create a new agent**.
3. Optionally enter per-call JSON variables, for example:

   ```json
   { "customer_name": "Alex" }
   ```

4. Select **Start call** and allow microphone access.
5. Speak normally, type a message, or try a suggested prompt.
6. While the agent is talking, speak over it to test barge-in.
7. Select **End** to close the session.
8. Open **Call history** to review the call, transcript, metrics, and recording when available.

Creating or publishing an agent changes your Smallest workspace. Calls can consume account usage or credits; use the sample prompts and this local demo at a small scale when testing.

## Built-in order tool

The default agent can demonstrate a client-side tool named `get_order_status`. The local demo database supports:

| Order ID | Status |
| --- | --- |
| `ORD-9821` | Out for delivery via BlueDart |
| `ORD-1042` | Delivered via Delhivery |
| `ORD-7788` | Processing |

Try: **“What's the status of order ORD-9821?”**

Unknown order IDs return a structured `not_found` response. The order lookup is simulated locally and is not connected to a real commerce backend.

## HTTP API exposed by this app

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Check server and API-key status |
| `GET` | `/api/voices` | List available English voices |
| `GET` | `/api/agents` | List unarchived workspace agents |
| `POST` | `/api/agents` | Create, configure, and publish an agent |
| `GET` | `/api/agents/:id` | Get an agent's resolved settings |
| `POST` | `/api/calls` | Register a web call and obtain a realtime access token |
| `GET` | `/api/calls` | List call logs and pagination metadata |
| `GET` | `/api/calls/:id` | Fetch call details and transcript |
| `GET` | `/api/calls/:id/recording` | Fetch a mono or dual-channel recording URL |
| `GET` | `/api/demo/orders/:orderId` | Serve sample order data for the client tool |

## Project structure

```text
.
├── server.js              # HTTP API proxy, agent creation, call history, and demo tools
├── package.json           # Node.js scripts and project metadata
├── public/
│   ├── index.html         # Application layout and documentation panels
│   ├── app.js             # WebSocket, microphone, playback, UI, and call-history logic
│   ├── pcm-worklet.js     # 20 ms PCM audio capture worklet
│   └── styles.css         # Dark interface styles
├── chat-qa-report.md      # Notes and evidence for the related Atoms QA trial
├── .env.example           # Environment variable template
└── README.md
```

## Troubleshooting

### `Missing API key`

- Confirm `.env` exists in the project root.
- Confirm it contains `SMALLEST_API_KEY=...`.
- Restart the server after changing environment variables.

### Microphone does not activate

- Open the app through `http://localhost:3000`, not a LAN IP.
- Allow microphone permission for `localhost` in browser site settings.
- Close other applications that may already hold the microphone.

### Agent creation does not finish

Agent publishing performs a security scan and polling until a revision is published or the server reports an error. A failed or incomplete scan may leave the agent shell in the workspace. Check the workspace dashboard before retrying.

### Call history is empty

Call history reads records from your Smallest workspace account. Confirm that the call has completed or allow a short delay for the call record to appear.

### WebSocket or API requests fail

The server logs upstream HTTP and WebSocket errors. Check network access to `api.smallest.ai`, API-key validity, account usage, and the browser developer console.

## Security notes

- Do not commit `.env`, API keys, call recordings, transcripts, or account data.
- The server currently has no authentication; if it is exposed beyond `127.0.0.1`, unauthenticated users can use the configured API key and create agents or calls.
- Keep `HOST=127.0.0.1` for local-only use unless you intentionally add authentication and HTTPS before deploying.

## Related documentation

- [Atoms realtime-agent API reference](https://docs.smallest.ai/api-reference/voice-agents/realtime-agent/realtime-agent)
- [Browser voice cookbook](https://docs.smallest.ai/voice-agents/integrate/browser-voice-cookbook)
- [Smallest.ai API key dashboard](https://app.smallest.ai/dashboard/api-keys)
