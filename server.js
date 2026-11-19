/**
 * Small Atoms voice-agent demo — zero-dependency Node server.
 *
 * Why a server at all?
 *   The browser must never see the Smallest API key. This server keeps the key,
 *   creates agents, and mints short-lived (30 s, single-use) call tokens with
 *   POST /conversation/register-call. The browser only receives a `wct_…` token.
 *
 * Run:  node server.js      →  http://localhost:3000
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

loadDotEnv(path.join(ROOT, ".env"));

const API_KEY =
  process.env.SMALLEST_API_KEY ||
  process.env.API_Key ||
  process.env.API_KEY ||
  process.env.SMALLEST_KEY ||
  "";

const ATOMS_BASE = "https://api.smallest.ai/atoms/v1";
const MODELS_BASE = "https://api.smallest.ai";
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

if (!API_KEY) {
  console.error(
    "\n  Missing API key.\n" +
      "  Add SMALLEST_API_KEY=sk_... (or API_Key=sk_...) to .env, then restart.\n"
  );
  process.exit(1);
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
}

/** Call the Atoms API with the secret key. Throws a clean HttpError on failure. */
async function atoms(pathname, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(ATOMS_BASE + pathname, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new HttpError(502, `Could not reach api.smallest.ai (${err.message})`);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok || (data && data.status === false)) {
    const message =
      (Array.isArray(data?.errors) && data.errors.join("; ")) ||
      data?.message ||
      res.statusText ||
      `Atoms API returned ${res.status}`;
    throw new HttpError(res.status, message, data);
  }
  return data;
}

/** Same, for the model APIs (voices). */
async function models(pathname) {
  const res = await fetch(MODELS_BASE + pathname, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new HttpError(res.status, data?.message || "Voice catalog unavailable", data);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Agent helpers
// ---------------------------------------------------------------------------

const VOICE_MODEL = "waves_lightning_v3_1_pro";
const FALLBACK_VOICES = [
  { id: "blake", name: "Blake", gender: "male", accent: "american" },
  { id: "chelsea", name: "Chelsea", gender: "female", accent: "american" },
  { id: "dean", name: "Dean", gender: "male", accent: "american" },
  { id: "kelsey", name: "Kelsey", gender: "female", accent: "american" },
  { id: "tabitha", name: "Tabitha", gender: "female", accent: "british" },
  { id: "callum", name: "Callum", gender: "male", accent: "british" },
  { id: "meher", name: "Meher", gender: "female", accent: "indian" },
  { id: "raghav", name: "Raghav", gender: "male", accent: "indian" },
];

let voiceCache = { at: 0, voices: [] };

async function getVoices() {
  if (voiceCache.voices.length && Date.now() - voiceCache.at < 10 * 60_000) {
    return voiceCache.voices;
  }
  try {
    const data = await models(`/waves/v1/lightning-v3.1-pro/get_voices`);
    const voices = (data.voices || [])
      .filter((v) => (v.tags?.language || []).includes("english"))
      .map((v) => ({
        id: v.voiceId,
        name: v.displayName,
        gender: v.tags?.gender || "male",
        accent: v.tags?.accent || "",
        usecases: v.tags?.usecases || [],
      }));
    if (voices.length) {
      voiceCache = { at: Date.now(), voices };
      return voices;
    }
  } catch (err) {
    console.warn("Voice catalog failed, using fallback:", err.message);
  }
  return FALLBACK_VOICES;
}

/** Build the tool definition used by the in-browser tool-execution demo. */
function orderTool() {
  return {
    type: "client_tool",
    name: "get_order_status",
    description:
      "Look up the live status of a customer order. Call this whenever the caller asks about an order, shipping, delivery, refund, or where their package is. Ask for the order id first if they have not given one.",
    llmParameters: [
      {
        name: "order_id",
        description: "The order id, for example ORD-9821",
        type: "text",
        required: true,
      },
    ],
    expectsResponse: true,
    timeoutMs: 8000,
    fillerPhrases: ["Let me check that for you.", "One moment please."],
  };
}

function shapeAgent(agent) {
  const resolved = agent._resolvedConfig || {};
  const voice = agent.synthesizer?.voiceConfig || {};
  return {
    id: agent._id,
    name: agent.name,
    description: agent.description || "",
    firstMessage: agent.firstMessage || resolved.firstMessage || "",
    prompt: resolved.prompt || agent.globalPrompt || "",
    tools: resolved.tools || [],
    voiceId: voice.voiceId || "blake",
    voiceModel: voice.model || VOICE_MODEL,
    language: agent.language?.default || "en",
    allowInterruptions: agent.allowInterruptions !== false,
    defaultVariables: agent.defaultVariables || {},
    totalCalls: agent.totalCalls || 0,
  };
}

async function getAgent(agentId) {
  const data = await atoms(`/agent/${encodeURIComponent(agentId)}`);
  if (!data?.data) throw new HttpError(404, "Agent not found");
  return shapeAgent(data.data);
}

// ---------------------------------------------------------------------------
// Call history (the same records the Atoms dashboard shows)
// ---------------------------------------------------------------------------

function shapeCallLog(log) {
  const agentRef =
    log.agentId && typeof log.agentId === "object"
      ? log.agentId
      : { _id: log.agentId, name: log.agentName || "" };
  const latency = log.turnLatencyMetrics || null;

  return {
    callId: log.callId,
    status: log.status || "unknown",
    type: log.type || "webcall",
    duration: Number(log.duration || 0),
    cost: Number(log.callCost || 0),
    createdAt: log.createdAt || null,
    disconnectionReason: log.disconnectionReason || null,
    agentId: agentRef._id || "",
    agentName: agentRef.name || "",
    summary: log.postCallAnalytics?.summary || "",
    hasRecording: Boolean(log.recordingUrl),
    versionNumber: log.versionNumber ?? null,
    branchName: log.branchName || "",
    revisionNumber: log.revisionNumber ?? null,
    isTest: Boolean(log.isTest),
    latency: latency
      ? {
          turns: latency.turns || 0,
          avg: latency.avgLatency ?? null,
          median: latency.medianLatency ?? null,
          min: latency.minLatency ?? null,
          max: latency.maxLatency ?? null,
          transitions: (latency.transitions || []).slice(0, 60).map((t) => ({
            turn: t.turn,
            userEnd: t.user_end,
            botStart: t.bot_start,
            latency: t.latency,
          })),
        }
      : null,
    dispositionMetrics: log.dispositionMetrics || {},
  };
}

function shapeCallDetail(data, callId) {
  const transcript = (data.transcript || [])
    .map((item) => ({
      role: item.role === "agent" || item.role === "assistant" ? "agent" : "user",
      text: item.content ?? item.text ?? "",
      at: item.timestamp || null,
    }))
    .filter((item) => item.text);

  const allEvents = data.events || [];

  return {
    callId: data.callId || callId,
    agentName: data.agentName || "",
    workflowType: data.workflowType || "",
    durationMs: Number(data.callDurationMs || 0),
    transcript,
    events: allEvents.slice(0, 400).map((event) => ({
      type: event.eventType || "event",
      at: event.eventTime || null,
      source: event.source || "",
      metrics: event.metrics || "",
    })),
    eventCount: allEvents.length,
    version: data.version || null,
  };
}

async function getMainBranch(agentId) {
  const data = await atoms(`/agent/${encodeURIComponent(agentId)}/branches`);
  const branches = data?.data?.branches || [];
  const main = branches.find((b) => b.branch?.isDefault) || branches[0];
  if (!main) throw new HttpError(500, "Agent has no branch");
  return main;
}

/**
 * The real create flow (the blog stops at POST /agents, which is only half true):
 *   1. POST /agent                    → a shell agent
 *   2. GET  /agent/:id/branches        → find Main
 *   3. PUT  .../branches/:id/draft     → prompt, voice, first message, tools
 *   4. POST .../draft/publish          → starts a security scan (202)
 *   5. poll revisions                  → until the new revision is published
 */
async function createAgent(input) {
  // Atoms only accepts letters, numbers, spaces and common punctuation in names.
  const name =
    String(input.name || "")
      .replace(/[^\p{L}\p{N} .,'()\-]/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || `Atoms demo ${new Date().toISOString().slice(11, 19)}`;
  const prompt =
    String(input.prompt || "").trim() ||
    "You are a friendly, concise voice assistant. Keep every answer to one or two sentences.";
  const firstMessage =
    String(input.firstMessage || "").trim() || "Hi! How can I help you today?";
  const withTool = input.orderTool !== false;

  const voices = await getVoices();
  const picked = voices.find((v) => v.id === input.voiceId);
  const voiceId = picked?.id || input.voiceId || "blake";
  const gender = picked?.gender || input.gender || "male";

  const fullPrompt = withTool
    ? `${prompt}\n\n# Tools\n- get_order_status: call this whenever the caller asks about an order. Ask for the order id if it is missing, then read the important fields back naturally.`
    : prompt;

  const created = await atoms("/agent", {
    method: "POST",
    body: {
      name,
      description: String(input.description || "Created by the Atoms demo UI").slice(0, 240),
    },
  });
  const agentId = created?.data;
  if (!agentId) throw new HttpError(502, "Agent creation returned no id");

  try {
    const main = await getMainBranch(agentId);
    const branchId = main.branch._id;
    const startRevision = main.headRevisionNumber || main.revisionsCount || 0;

    const tools = withTool ? [orderTool()] : [];

    await atoms(`/agent/${agentId}/branches/${branchId}/draft`, {
      method: "PUT",
      body: {
        globalPrompt: fullPrompt,
        firstMessage,
        synthesizer: {
          voiceConfig: { model: VOICE_MODEL, voiceId, gender },
          speed: 1,
          sampleRate: 24000,
        },
        language: {
          default: "en",
          supported: ["en"],
          switching: { isEnabled: false },
        },
        singlePromptConfig: { prompt: fullPrompt, tools },
        allowInterruptions: true,
        waitForUserToSpeakFirst: false,
        smartTurnConfig: { isEnabled: true, waitTimeInSecs: 1.6 },
        voiceDetectionConfig: {
          confidence: 0.6,
          minVolume: 0.5,
          triggerTimeInSecs: 0.2,
          releaseTimeInSecs: 0.6,
        },
        denoisingConfig: { isEnabled: true },
        backgroundSound: "",
        // A demo agent should not feel like a phone tree.
        enableStyleGuide: false,
        speechFormatting: true,
      },
    });

    const publish = await atoms(`/agent/${agentId}/branches/${branchId}/draft/publish`, {
      method: "POST",
      body: { label: "Created from the Atoms demo UI" },
    });

    if (publish?.data?.state === "scanning") {
      const deadline = Date.now() + 50_000;
      let head = null;
      while (Date.now() < deadline) {
        await sleep(1500);
        const revs = await atoms(
          `/agent/${agentId}/branches/${branchId}/revisions?limit=5`
        );
        head = revs?.data?.revisions?.[0];
        if (head && head.revisionNumber > startRevision) {
          if (head.securityCheck?.status === "failed") {
            throw new HttpError(
              422,
              "The prompt failed the security scan. Try rephrasing it.",
              head.securityCheck
            );
          }
          if (head.status === "published") break;
        }
      }
      if (!head || head.status !== "published") {
        throw new HttpError(
          504,
          "Publishing is taking longer than usual. The agent was created — open the dashboard to check its version status."
        );
      }
    }

    return await getAgent(agentId);
  } catch (err) {
    // Leave a breadcrumb so the orphaned agent is easy to spot in the dashboard.
    console.error(`Agent ${agentId} was created but configuring it failed:`, err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Fake order database for the client-tool demo
// ---------------------------------------------------------------------------

const ORDERS = {
  "ORD-9821": {
    order_id: "ORD-9821",
    status: "Out for delivery",
    carrier: "BlueDart",
    eta: "today by 7:00 PM",
    items: ["Atoms API annual plan"],
    total: "$499.00",
  },
  "ORD-1042": {
    order_id: "ORD-1042",
    status: "Delivered",
    delivered_at: "yesterday at 3:12 PM",
    carrier: "Delhivery",
    items: ["Lightning TTS credits — 1M characters"],
    total: "$120.00",
  },
  "ORD-7788": {
    order_id: "ORD-7788",
    status: "Processing",
    eta: "ships in 2 business days",
    items: ["Voice clone add-on"],
    total: "$49.00",
  },
};

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(res, pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error("Request failed:", err);
    sendJson(res, status, {
      error: err.message || "Internal server error",
      details: err instanceof HttpError ? err.details : undefined,
    });
  }
});

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  // --- health -------------------------------------------------------------
  if (pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true, hasKey: Boolean(API_KEY) });
    return;
  }

  // --- voices -------------------------------------------------------------
  if (pathname === "/api/voices" && req.method === "GET") {
    const voices = await getVoices();
    const order = { american: 0, british: 1, indian: 2 };
    voices.sort(
      (a, b) =>
        (order[a.accent] ?? 3) - (order[b.accent] ?? 3) ||
        a.name.localeCompare(b.name)
    );
    sendJson(res, 200, { voices, model: VOICE_MODEL });
    return;
  }

  // --- agents -------------------------------------------------------------
  if (pathname === "/api/agents" && req.method === "GET") {
    const data = await atoms("/agent?offset=50&sortField=updatedAt&sortOrder=desc");
    const agents = (data?.data?.agents || [])
      .filter((a) => !a.archived)
      .map((a) => ({
        id: a._id,
        name: a.name,
        description: a.description || "",
        firstMessage: a.firstMessage || "",
        voiceId: a.synthesizer?.voiceConfig?.voiceId || "blake",
        language: a.language?.default || "en",
        totalCalls: a.totalCalls || 0,
      }));
    sendJson(res, 200, { agents });
    return;
  }

  if (pathname === "/api/agents" && req.method === "POST") {
    const body = await readJsonBody(req);
    const agent = await createAgent(body);
    sendJson(res, 201, { agent });
    return;
  }

  const agentMatch = pathname.match(/^\/api\/agents\/([A-Za-z0-9-]+)$/);
  if (agentMatch && req.method === "GET") {
    const agent = await getAgent(agentMatch[1]);
    sendJson(res, 200, { agent });
    return;
  }

  // --- call tokens --------------------------------------------------------
  if (pathname === "/api/calls" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body.agentId) throw new HttpError(400, "agentId is required");

    const variables =
      body.variables && typeof body.variables === "object" && !Array.isArray(body.variables)
        ? body.variables
        : undefined;

    const data = await atoms("/conversation/register-call", {
      method: "POST",
      body: {
        agent_id: body.agentId,
        mode: "webcall",
        input_audio_format: "pcm_24000",
        output_audio_format: "pcm_24000",
        ...(variables && Object.keys(variables).length ? { variables } : {}),
      },
    });

    sendJson(res, 200, data.data);
    return;
  }

  // --- call history -------------------------------------------------------
  if (pathname === "/api/calls" && req.method === "GET") {
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });

    const agentId = url.searchParams.get("agentId");
    if (agentId) query.set("agentIds", agentId);

    const callType = url.searchParams.get("type");
    if (callType) query.set("callTypes", callType);

    const search = url.searchParams.get("search");
    if (search) query.set("search", search);

    const status = url.searchParams.get("status");
    if (status) query.set("statusFilter", status);

    const data = await atoms(`/conversation?${query.toString()}`);
    const calls = (data?.data?.logs || []).map(shapeCallLog);

    sendJson(res, 200, {
      calls,
      pagination: data?.data?.pagination || {
        page,
        limit,
        total: calls.length,
        hasMore: false,
      },
    });
    return;
  }

  const callRecordingMatch = pathname.match(
    /^\/api\/calls\/([A-Za-z0-9-]+)\/recording$/
  );
  if (callRecordingMatch && req.method === "GET") {
    const channel = url.searchParams.get("channel") === "dual" ? "dual" : "mono";
    const data = await atoms(
      `/recordings/${encodeURIComponent(callRecordingMatch[1])}?channel=${channel}`
    );
    const recordingUrl = data?.data?.url;
    if (!recordingUrl) throw new HttpError(404, "No recording available for this call");
    sendJson(res, 200, { url: recordingUrl, channel });
    return;
  }

  const callMatch = pathname.match(/^\/api\/calls\/([A-Za-z0-9-]+)$/);
  if (callMatch && req.method === "GET") {
    const callId = callMatch[1];
    const data = await atoms(
      `/analytics/conversation-details/${encodeURIComponent(callId)}`
    );
    sendJson(res, 200, { call: shapeCallDetail(data?.data || {}, callId) });
    return;
  }

  // --- demo tool endpoint (executed by the browser, not by Atoms) ---------
  const orderMatch = pathname.match(/^\/api\/demo\/orders\/([A-Za-z0-9-]+)$/);
  if (orderMatch && req.method === "GET") {
    await sleep(350); // pretend to be a slow order system
    const id = decodeURIComponent(orderMatch[1]).toUpperCase();
    const order = ORDERS[id];
    sendJson(
      res,
      200,
      order || {
        error: "not_found",
        message: `No order found with id ${id}. The demo knows ORD-9821, ORD-1042 and ORD-7788.`,
      }
    );
    return;
  }

  throw new HttpError(404, "Not found");
}

function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, requested));
  const relative = path.relative(PUBLIC_DIR, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  fs.readFile(file, (err, content) => {
    if (err) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(content);
  });
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(json);
}

server.listen(PORT, HOST, () => {
  console.log(`\n  ▶  Atoms voice demo      http://localhost:${PORT}`);
  console.log(`     key loaded            ${API_KEY.slice(0, 3)}…${API_KEY.slice(-4)}`);
  console.log(`     mic requires          http://localhost (not 127.0.0.1 over LAN)\n`);
});
