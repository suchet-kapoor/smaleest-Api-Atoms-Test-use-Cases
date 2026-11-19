/**
 * Browser side of the Atoms voice demo.
 *
 * Deliberately uses the raw realtime WebSocket protocol instead of the Agent
 * Web SDK, because the SDK does not expose `function_call` events — and this
 * demo shows client tools. Every frame is visible in the Wire panel.
 *
 * Protocol (api.smallest.ai/atoms/v1/agent/connect):
 *   ↑ input_audio_buffer.append   { audio: base64 PCM16 }
 *   ↑ input_text.send             { text }
 *   ↑ function_call.result        { call_id, output }
 *   ↑ session.close
 *   ↓ session.created / session.closed
 *   ↓ output_audio.delta          { audio: base64 PCM16 }
 *   ↓ transcript / transcript.delta
 *   ↓ agent_start_talking / agent_stop_talking
 *   ↓ interruption
 *   ↓ error
 */

const WS_URL = "wss://api.smallest.ai/atoms/v1/agent/connect";
const IN_RATE = 24_000; // declared to register-call as pcm_24000

const $ = (id) => document.getElementById(id);

const els = {
  agentSelect: $("agentSelect"),
  refreshAgents: $("refreshAgents"),
  agentSummary: $("agentSummary"),
  agentPromptBody: $("agentPromptBody"),
  variables: $("variables"),
  creator: $("creator"),
  newAgentForm: $("newAgentForm"),
  newName: $("newName"),
  newPrompt: $("newPrompt"),
  newFirstMessage: $("newFirstMessage"),
  voiceSelect: $("voiceSelect"),
  orderTool: $("orderTool"),
  createBtn: $("createBtn"),
  createStatus: $("createStatus"),

  startBtn: $("startBtn"),
  endBtn: $("endBtn"),
  muteBtn: $("muteBtn"),
  textForm: $("textForm"),
  textInput: $("textInput"),
  chips: $("chips"),

  connPill: $("connPill"),
  stageStatus: $("stageStatus"),
  orb: $("orb"),
  viz: $("viz"),
  callTimer: $("callTimer"),

  transcript: $("transcript"),
  transcriptEmpty: $("transcriptEmpty"),

  ttfbValue: $("ttfbValue"),
  turnValue: $("turnValue"),
  chunksValue: $("chunksValue"),
  sessionValue: $("sessionValue"),
  wireLog: $("wireLog"),
  clearLog: $("clearLog"),
  logCount: $("logCount"),
  toast: $("toast"),

  historyBtn: $("historyBtn"),
  historyBadge: $("historyBadge"),
  historyDialog: $("historyDialog"),
  historyClose: $("historyClose"),
  historyRefresh: $("historyRefresh"),
  historyAgent: $("historyAgent"),
  historySearch: $("historySearch"),
  historyCount: $("historyCount"),
  historyList: $("historyList"),
  historyDetail: $("historyDetail"),
  historyMore: $("historyMore"),
};

const state = {
  agents: [],
  agent: null,
  voices: [],

  ws: null,
  session: null,
  ending: false,
  connected: false,
  muted: false,
  timer: null,
  startedAt: 0,

  ctx: null,
  stream: null,
  micSource: null,
  worklet: null,
  inAnalyser: null,
  outAnalyser: null,
  outGain: null,
  silentGain: null,

  nextPlayTime: 0,
  sources: new Set(),
  audioFrames: 0,
  audioBytes: 0,
  chunksIn: 0,
  bytesIn: 0,
  inputRow: null,
  audioRow: null,

  userFinalAt: 0,
  ttfbPending: false,
  ttfbSamples: [],
  turnStart: 0,

  liveBubbles: { user: null, assistant: null },
  assistantContinuation: false,
  agentTalking: false,
  levels: new Float32Array(56),
  toastTimer: null,

  history: {
    calls: [],
    page: 1,
    total: 0,
    hasMore: false,
    selectedId: null,
    seq: 0,
    log: null,
    detail: null,
  },
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

init().catch((err) => {
  console.error(err);
  showToast(err.message || String(err));
  setPill("Error", "error");
});

async function init() {
  bindEvents();
  drawVisualizer();
  resetMetrics();
  await Promise.allSettled([loadVoices(), loadAgents()]);
  loadHistoryCount();
  setStartEnabled(Boolean(state.agent));
}

function bindEvents() {
  els.refreshAgents.addEventListener("click", () => loadAgents());
  els.agentSelect.addEventListener("change", () => selectAgent(els.agentSelect.value));

  els.newAgentForm.addEventListener("submit", createAgent);
  els.startBtn.addEventListener("click", startCall);
  els.endBtn.addEventListener("click", () => endCall("client_requested"));
  els.muteBtn.addEventListener("click", toggleMute);

  els.textForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendText();
  });

  els.chips.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-say]");
    if (!button) return;
    els.textInput.value = button.dataset.say;
    els.textInput.focus();
  });

  els.clearLog.addEventListener("click", () => {
    els.wireLog.replaceChildren();
    state.inputRow = null;
    state.audioRow = null;
    logRows = 0;
    els.logCount.textContent = "0";
  });

  // Call history dialog
  els.historyBtn.addEventListener("click", openHistory);
  els.historyClose.addEventListener("click", () => els.historyDialog.close());
  els.historyDialog.addEventListener("click", (event) => {
    if (event.target === els.historyDialog) els.historyDialog.close();
  });
  els.historyRefresh.addEventListener("click", () => {
    loadHistory({ reset: true });
    loadHistoryCount();
  });
  els.historyAgent.addEventListener("change", () => loadHistory({ reset: true }));
  let historySearchTimer = null;
  els.historySearch.addEventListener("input", () => {
    clearTimeout(historySearchTimer);
    historySearchTimer = setTimeout(() => loadHistory({ reset: true }), 400);
  });
  els.historyMore.addEventListener("click", () => loadHistory({ reset: false }));
  els.historyList.addEventListener("click", (event) => {
    const item = event.target.closest(".history-item");
    if (item) selectCall(item.dataset.callId);
  });
  els.historyDetail.addEventListener("click", async (event) => {
    const copy = event.target.closest("[data-copy-call]");
    if (copy) {
      try {
        await navigator.clipboard.writeText(state.history.selectedId || "");
        copy.textContent = "copied";
        setTimeout(() => (copy.textContent = "copy"), 1200);
      } catch { /* clipboard blocked */ }
    }
  });

  window.addEventListener("beforeunload", () => {
    try {
      state.ws?.send(JSON.stringify({ type: "session.close" }));
      state.ws?.close();
    } catch { /* ignore */ }
  });
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function setPill(label, variant = "") {
  els.connPill.className = `pill ${variant}`.trim();
  els.connPill.lastElementChild.textContent = label;
}

function setStatus(text) {
  els.stageStatus.textContent = text;
}

function showToast(message, ok = false) {
  els.toast.hidden = false;
  els.toast.textContent = message;
  els.toast.className = `toast${ok ? " ok" : ""}`;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 5200);
}

function setStartEnabled(enabled) {
  els.startBtn.disabled = !enabled || state.connected || state.ws !== null;
}

function setLiveControls(live) {
  els.endBtn.disabled = !live;
  els.muteBtn.disabled = !live;
  setStartEnabled(!live);
  els.orb.classList.toggle("live", live);
  if (!live) {
    els.orb.classList.remove("talking", "listening");
  }
}

function resetMetrics() {
  els.ttfbValue.textContent = "—";
  els.turnValue.textContent = "—";
  els.chunksValue.textContent = "0";
  els.sessionValue.textContent = "—";
  els.callTimer.textContent = "00:00";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Agents + voices
// ---------------------------------------------------------------------------

async function loadVoices() {
  try {
    const data = await api("/api/voices");
    state.voices = data.voices || [];
    renderVoices();
  } catch (err) {
    console.warn("Voices failed:", err);
    els.voiceSelect.innerHTML = '<option value="blake">Blake — male</option>';
  }
}

function renderVoices() {
  const groups = [
    ["american", "American"],
    ["british", "British"],
    ["indian", "Indian"],
    ["", "Other"],
  ];
  const frag = document.createDocumentFragment();
  const used = new Set();

  for (const [accent, label] of groups) {
    const voices = state.voices.filter((v) => (v.accent || "") === accent);
    if (!voices.length) continue;
    const group = document.createElement("optgroup");
    group.label = label;
    for (const voice of voices) {
      const option = document.createElement("option");
      option.value = voice.id;
      option.dataset.gender = voice.gender;
      option.textContent = `${voice.name} — ${voice.gender}`;
      used.add(voice.id);
      group.append(option);
    }
    frag.append(group);
  }

  // Any accent values we did not group explicitly.
  const rest = state.voices.filter((v) => !used.has(v.id));
  if (rest.length) {
    const group = document.createElement("optgroup");
    group.label = "More voices";
    for (const voice of rest) {
      const option = document.createElement("option");
      option.value = voice.id;
      option.dataset.gender = voice.gender;
      option.textContent = `${voice.name}${voice.accent ? ` — ${voice.accent}` : ""}`;
      group.append(option);
    }
    frag.append(group);
  }

  els.voiceSelect.replaceChildren(frag);
  if ([...els.voiceSelect.options].some((o) => o.value === "blake")) {
    els.voiceSelect.value = "blake";
  }
}

async function loadAgents() {
  els.agentSelect.disabled = true;
  try {
    const data = await api("/api/agents");
    state.agents = data.agents || [];
    renderHistoryAgentFilter();

    if (!state.agents.length) {
      els.agentSelect.innerHTML = '<option value="">No agents yet</option>';
      els.agentSelect.disabled = true;
      state.agent = null;
      renderAgentSummary(null);
      setStartEnabled(false);
      setStatus("Create an agent on the left, then start a call.");
      els.creator.open = true;
      return;
    }

    const previous = state.agent?.id || els.agentSelect.value;
    els.agentSelect.innerHTML = "";
    for (const agent of state.agents) {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = agent.name;
      els.agentSelect.append(option);
    }
    els.agentSelect.disabled = false;

    const next = state.agents.some((a) => a.id === previous)
      ? previous
      : state.agents[0].id;
    els.agentSelect.value = next;
    await selectAgent(next);
  } catch (err) {
    console.error(err);
    els.agentSelect.innerHTML = '<option value="">Could not load agents</option>';
    els.agentSelect.disabled = true;
    setStatus("Could not list agents. Check the server console.");
    showToast(err.message);
  }
}

async function selectAgent(agentId) {
  if (!agentId) return;
  els.agentSummary.innerHTML = '<p class="muted">Loading agent…</p>';
  try {
    const data = await api(`/api/agents/${encodeURIComponent(agentId)}`);
    state.agent = data.agent;
    renderAgentSummary(state.agent);
    setStartEnabled(!state.connected);
    if (!state.connected) {
      setStatus("Ready. Start a call and allow microphone access.");
    }
  } catch (err) {
    console.error(err);
    state.agent = null;
    els.agentSummary.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
    setStartEnabled(false);
  }
}

function renderAgentSummary(agent) {
  if (!agent) {
    els.agentSummary.innerHTML =
      '<p class="muted">No agent selected. Use “Create a new agent” below.</p>';
    els.agentPromptBody.textContent = "—";
    return;
  }

  els.agentSummary.innerHTML = `
    <div class="name">${escapeHtml(agent.name)}</div>
    ${agent.description ? `<p class="desc">${escapeHtml(agent.description)}</p>` : ""}
    ${agent.firstMessage ? `<p class="first">“${escapeHtml(agent.firstMessage)}”</p>` : ""}
    <div class="badges">
      <span class="badge teal">${escapeHtml(agent.voiceId)}</span>
      <span class="badge">${escapeHtml(agent.language)}</span>
      <span class="badge">electron</span>
      ${agent.tools?.length ? `<span class="badge amber">${agent.tools.length} tool${agent.tools.length > 1 ? "s" : ""}</span>` : ""}
      ${agent.allowInterruptions ? '<span class="badge">barge-in on</span>' : ""}
    </div>
  `;

  const prompt = agent.prompt || "(prompt is set on the live version)";
  els.agentPromptBody.textContent = prompt;

  if (agent.defaultVariables && Object.keys(agent.defaultVariables).length) {
    if (!els.variables.value.trim()) {
      els.variables.placeholder = JSON.stringify(agent.defaultVariables, null, 0);
    }
  }
}

async function createAgent(event) {
  event.preventDefault();
  const name = els.newName.value.trim();
  if (!name) return;

  const voiceOption = els.voiceSelect.selectedOptions[0];
  const payload = {
    name,
    prompt: els.newPrompt.value,
    firstMessage: els.newFirstMessage.value,
    voiceId: els.voiceSelect.value,
    gender: voiceOption?.dataset.gender || "male",
    orderTool: els.orderTool.checked,
  };

  els.createBtn.disabled = true;
  const started = performance.now();
  let phase = 0;
  setCreateStatus("Creating agent…", false);
  const ticker = setInterval(() => {
    const seconds = ((performance.now() - started) / 1000).toFixed(0);
    if (seconds >= 3 && phase === 0) {
      phase = 1;
      setCreateStatus(`Publishing + security scan… ${seconds}s`, false);
    } else {
      setCreateStatus(
        `${phase === 0 ? "Creating agent" : "Publishing + security scan"}… ${seconds}s`,
        false
      );
    }
  }, 1000);

  try {
    const data = await api("/api/agents", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    clearInterval(ticker);
    setCreateStatus(`Published “${data.agent.name}” ✓`, false);
    showToast("Agent created and live. Starting a call will use it.", true);
    await loadAgents();
    els.agentSelect.value = data.agent.id;
    await selectAgent(data.agent.id);
    els.creator.open = false;
  } catch (err) {
    clearInterval(ticker);
    setCreateStatus(err.message, true);
    showToast(err.message);
  } finally {
    els.createBtn.disabled = false;
  }
}

function setCreateStatus(text, isError) {
  els.createStatus.textContent = text;
  els.createStatus.classList.toggle("error", Boolean(isError));
}

// ---------------------------------------------------------------------------
// Call history
//
// Atoms persists every call. This panel is a thin view over:
//   GET /conversation                              → list + summary + metrics
//   GET /analytics/conversation-details/:callId    → transcript + events
//   GET /recordings/:callId?channel=mono           → 15-minute presigned WAV
// ---------------------------------------------------------------------------

function renderHistoryAgentFilter() {
  const current = els.historyAgent.value;
  const rows = ['<option value="">All agents</option>'];
  for (const agent of state.agents) {
    rows.push(`<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</option>`);
  }
  els.historyAgent.innerHTML = rows.join("");
  if ([...els.historyAgent.options].some((option) => option.value === current)) {
    els.historyAgent.value = current;
  }
}

function openHistory() {
  renderHistoryAgentFilter();
  if (!els.historyDialog.open) els.historyDialog.showModal();
  loadHistory({ reset: true });
  loadHistoryCount();
}

async function loadHistoryCount() {
  try {
    const data = await api("/api/calls?limit=1");
    const total = data.pagination?.total ?? data.calls?.length ?? 0;
    els.historyBadge.textContent = String(total);
    els.historyBadge.hidden = !total;
  } catch {
    // The badge is cosmetic; leave it as it was if the API is unreachable.
  }
}

async function loadHistory({ reset }) {
  const seq = ++state.history.seq;
  const page = reset ? 1 : state.history.page;

  const params = new URLSearchParams({ page: String(page), limit: "20" });
  if (els.historyAgent.value) params.set("agentId", els.historyAgent.value);
  const search = els.historySearch.value.trim();
  if (search) params.set("search", search);

  els.historyMore.disabled = true;
  if (reset && !state.history.calls.length) renderHistoryList(true);

  try {
    const data = await api(`/api/calls?${params.toString()}`);
    if (seq !== state.history.seq) return;

    if (reset) {
      state.history.calls = data.calls || [];
    } else {
      const seen = new Set(state.history.calls.map((call) => call.callId));
      for (const call of data.calls || []) {
        if (!seen.has(call.callId)) state.history.calls.push(call);
      }
    }

    state.history.page = page + 1;
    state.history.hasMore = Boolean(data.pagination?.hasMore);
    state.history.total = data.pagination?.total ?? state.history.calls.length;

    els.historyCount.textContent = `${state.history.total} call${state.history.total === 1 ? "" : "s"}`;
    els.historyMore.hidden = !state.history.hasMore;
    renderHistoryList();

    if (reset) {
      const keep = state.history.calls.find(
        (call) => call.callId === state.history.selectedId
      );
      const target = keep || state.history.calls[0];
      if (target) {
        selectCall(target.callId, { refreshList: false });
      } else {
        state.history.selectedId = null;
        state.history.log = null;
        state.history.detail = null;
        els.historyDetail.innerHTML =
          '<div class="history-placeholder">No calls match these filters. Start a call and it will show up here when it ends.</div>';
      }
    }
  } catch (err) {
    if (seq !== state.history.seq) return;
    els.historyList.innerHTML = `<div class="history-placeholder">${escapeHtml(err.message)}</div>`;
    els.historyDetail.innerHTML =
      '<div class="history-placeholder">Could not load calls. Check the server console.</div>';
    els.historyCount.textContent = "—";
  } finally {
    if (seq === state.history.seq) {
      els.historyMore.disabled = false;
      els.historyMore.hidden = !state.history.hasMore;
    }
  }
}

function renderHistoryList(loading = false) {
  if (!state.history.calls.length) {
    els.historyList.innerHTML = `<div class="history-placeholder">${
      loading ? "Loading calls…" : "No calls yet. Start a call — it is saved automatically."
    }</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const call of state.history.calls) {
    const agentName =
      call.agentName ||
      state.agents.find((agent) => agent.id === call.agentId)?.name ||
      "Unknown agent";
    const item = document.createElement("button");
    item.type = "button";
    item.className = `history-item${
      call.callId === state.history.selectedId ? " selected" : ""
    }`;
    item.dataset.callId = call.callId;
    item.setAttribute("role", "option");
    item.setAttribute(
      "aria-selected",
      call.callId === state.history.selectedId ? "true" : "false"
    );

    const status = String(call.status || "unknown").replaceAll("_", " ");
    const isLive = call.status === "active" || call.status === "in_progress";
    item.innerHTML = `
      <div class="hi-top">
        <span class="hi-agent">${escapeHtml(agentName)}</span>
        <span class="hi-time" title="${escapeHtml(call.createdAt || "")}">${escapeHtml(
          formatCallTime(call.createdAt)
        )}</span>
      </div>
      <div class="hi-meta">
        <span class="status-dot ${statusClass(call.status)}"></span>
        <span>${escapeHtml(status)} · ${isLive ? "live" : escapeHtml(formatDuration(call.duration))}</span>
        <span class="cost">${escapeHtml(formatCost(call.cost))}</span>
      </div>
      <div class="hi-id">${escapeHtml(call.callId)}</div>
      ${call.summary ? `<div class="hi-summary">${escapeHtml(call.summary)}</div>` : ""}
    `;
    fragment.append(item);
  }
  els.historyList.replaceChildren(fragment);
}

async function selectCall(callId, { refreshList = true } = {}) {
  if (!callId) return;

  state.history.selectedId = callId;
  state.history.log = state.history.calls.find((call) => call.callId === callId) || null;
  state.history.detail = null;
  if (refreshList) renderHistoryList();
  renderCallDetail(state.history.log, null, null, true);

  try {
    const data = await api(`/api/calls/${encodeURIComponent(callId)}`);
    if (state.history.selectedId !== callId) return;
    state.history.detail = data.call;
    renderCallDetail(state.history.log, data.call, null, false);
  } catch (err) {
    if (state.history.selectedId !== callId) return;
    renderCallDetail(state.history.log, null, err.message, false);
  }
}

function renderCallDetail(log, detail, error, loading) {
  if (!log && !detail) {
    els.historyDetail.innerHTML =
      '<div class="history-placeholder">Select a call to read its transcript.</div>';
    return;
  }

  const callId = detail?.callId || log?.callId || "";
  const agentName =
    detail?.agentName ||
    log?.agentName ||
    state.agents.find((agent) => agent.id === log?.agentId)?.name ||
    "Call";
  const status = String(log?.status || "unknown").replaceAll("_", " ");
  const isLive = log?.status === "active" || log?.status === "in_progress";
  const started = log?.createdAt ? formatCallDate(log.createdAt) : "—";
  const duration = isLive
    ? "in progress"
    : log
      ? formatDuration(log.duration)
      : detail
        ? formatDuration(detail.durationMs / 1000)
        : "—";
  const cost = log ? formatCost(log.cost) : "—";
  const latency = log?.latency?.avg;

  const settings = [
    log?.type,
    log?.branchName,
    log?.versionNumber != null ? `v${log.versionNumber}` : null,
  ].filter(Boolean);

  const facts = `
    <div class="fact"><span>Started</span><strong title="${escapeHtml(log?.createdAt || "")}">${escapeHtml(started)}</strong></div>
    <div class="fact"><span>Duration</span><strong>${escapeHtml(duration)}</strong></div>
    <div class="fact"><span>Cost</span><strong>${escapeHtml(cost)}</strong></div>
    <div class="fact"><span>Avg reply</span><strong>${latency != null ? `${Number(latency).toFixed(2)}s` : "—"}</strong></div>
  `;

  const summary = log?.summary
    ? `<section class="detail-section">
        <h4>Post-call summary</h4>
        <p class="detail-summary">${escapeHtml(log.summary)}</p>
      </section>`
    : "";

  const latencyDetail =
    log?.latency?.turns
      ? `<p class="recording-note">${log.latency.turns} turn${log.latency.turns === 1 ? "" : "s"} · median ${Number(
          log.latency.median ?? 0
        ).toFixed(2)}s · min ${Number(log.latency.min ?? 0).toFixed(2)}s · max ${Number(
          log.latency.max ?? 0
        ).toFixed(2)}s</p>`
      : "";

  let transcriptHtml;
  if (loading) {
    transcriptHtml = '<div class="history-placeholder">Loading transcript…</div>';
  } else if (error) {
    transcriptHtml = `<div class="history-placeholder">${escapeHtml(error)}</div>`;
  } else if (detail?.transcript?.length) {
    transcriptHtml = detail.transcript
      .map(
        (turn) => `
        <div class="bubble ${turn.role === "agent" ? "assistant" : "user"}">
          <div class="who">${turn.role === "agent" ? "Agent" : "You"}
            <span class="ht-time">${escapeHtml(formatClock(turn.at))}</span>
          </div>
          <p>${escapeHtml(turn.text)}</p>
        </div>`
      )
      .join("");
  } else {
    transcriptHtml =
      '<div class="history-placeholder">No transcript yet — Atoms may still be processing this call. Refresh in a few seconds.</div>';
  }

  const recording = log?.hasRecording
    ? `<div class="recording-row">
        <button id="loadRecordingBtn" class="btn subtle" type="button">Load recording</button>
        <span class="recording-note">${escapeHtml(settings.join(" · "))} · mono WAV, link valid 15 min</span>
      </div>`
    : isLive
      ? '<p class="recording-note">The recording appears here after the call ends.</p>'
      : '<p class="recording-note">No recording was captured for this call.</p>';

  const liveNote = isLive
    ? '<p class="recording-note">This call is still running — press ↻ above to pull the latest turns.</p>'
    : "";

  const events = detail?.events || [];
  const eventList = events.length
    ? `<ul class="event-list">${events
        .slice(0, 120)
        .map(
          (event) =>
            `<li><time>${escapeHtml(formatClock(event.at))}</time><b>${escapeHtml(
              event.type
            )}</b>${event.source ? `<span>${escapeHtml(event.source)}</span>` : ""}</li>`
        )
        .join("")}</ul>
       ${detail.eventCount > 120 ? `<p class="recording-note">Showing 120 of ${detail.eventCount} events.</p>` : ""}`
    : "";

  const raw = escapeHtml(
    JSON.stringify({ log, call: detail, eventsReturned: events.length }, null, 2)
  );

  els.historyDetail.innerHTML = `
    <div class="detail-head">
      <div>
        <h3>${escapeHtml(agentName)}</h3>
        <div class="detail-id">
          <span>${escapeHtml(callId)}</span>
          <button type="button" data-copy-call title="Copy call id">copy</button>
        </div>
      </div>
      <div class="badges">
        <span class="badge"><span class="status-dot ${statusClass(log?.status)}"></span> ${escapeHtml(status)}</span>
        ${log?.isTest ? '<span class="badge amber">test</span>' : ""}
      </div>
    </div>

    <div class="detail-facts">${facts}</div>
    ${liveNote}
    ${summary}
    ${latencyDetail}

    <section class="detail-section">
      <h4>Recording</h4>
      ${recording}
    </section>

    <section class="detail-section">
      <h4>Transcript <span class="count">${
        detail?.transcript?.length ? `${detail.transcript.length} turns` : ""
      }</span></h4>
      <div class="history-transcript">${transcriptHtml}</div>
    </section>

    <details class="detail-raw">
      <summary>Events & raw data${events.length ? ` · ${detail.eventCount} events` : ""}</summary>
      ${eventList}
      <pre class="raw-json">${raw}</pre>
    </details>
  `;

  const recordingButton = els.historyDetail.querySelector("#loadRecordingBtn");
  if (recordingButton) {
    recordingButton.addEventListener("click", () => loadRecording(callId, recordingButton));
  }
}

async function loadRecording(callId, button) {
  const row = button.closest(".recording-row");
  button.disabled = true;
  button.textContent = "Loading…";

  try {
    const data = await api(`/api/calls/${encodeURIComponent(callId)}/recording`);
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.autoplay = true;
    audio.src = data.url;
    row.replaceChildren(audio);
    audio.play().catch(() => {});
  } catch (err) {
    button.disabled = false;
    button.textContent = "Try again";
    const note = row.querySelector(".recording-note");
    if (note) note.textContent = err.message;
  }
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const rest = String(total % 60).padStart(2, "0");
  return `${minutes}m ${rest}s`;
}

function formatCost(cost) {
  const value = Number(cost);
  if (!value) return "—";
  return `$${value.toFixed(3)}`;
}

function formatCallTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const now = new Date();
  const time = formatClock(iso);

  if (date.toDateString() === now.toDateString()) return time;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;

  return `${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })} ${time}`;
}

function formatCallDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatClock(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusClass(status) {
  return String(status || "").replaceAll(" ", "_");
}

// ---------------------------------------------------------------------------
// Call lifecycle
// ---------------------------------------------------------------------------

async function startCall() {
  if (!state.agent) {
    showToast("Pick or create an agent first.");
    return;
  }
  if (state.connected || state.ws) return;

  let variables;
  const rawVariables = els.variables.value.trim();
  if (rawVariables) {
    try {
      variables = JSON.parse(rawVariables);
    } catch {
      showToast("Per-call variables must be valid JSON.");
      els.variables.focus();
      return;
    }
    if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
      showToast("Per-call variables must be a JSON object.");
      return;
    }
  }

  els.startBtn.disabled = true;
  setPill("Connecting", "connecting");
  setStatus("Preparing microphone…");

  try {
    await ensureAudio();
    await startMicrophone();
  } catch (err) {
    console.error(err);
    setPill("Mic blocked", "error");
    setStatus("Microphone permission is required. Allow it, then press Start again.");
    showToast(
      err.name === "NotAllowedError"
        ? "Microphone permission was denied. Allow it in the address bar."
        : `Could not start the microphone: ${err.message}`
    );
    setStartEnabled(true);
    return;
  }

  clearTranscript();
  resetMetrics();
  state.ttfbSamples = [];
  state.ttfbPending = false;
  state.chunksIn = 0;
  state.bytesIn = 0;
  state.audioFrames = 0;
  state.audioBytes = 0;
  state.userFinalAt = 0;
  state.turnStart = 0;
  state.inputRow = null;
  state.audioRow = null;

  setStatus("Minting a 30-second call token on the server…");
  let tokenData;
  try {
    tokenData = await api("/api/calls", {
      method: "POST",
      body: JSON.stringify({ agentId: state.agent.id, variables }),
    });
    logWire("sys", "register-call", `token ${String(tokenData.access_token).slice(0, 8)}… · ${tokenData.expires_in}s TTL`);
  } catch (err) {
    console.error(err);
    stopMicrophone();
    setPill("Idle");
    setStatus("Could not create a call token.");
    showToast(err.message);
    setStartEnabled(true);
    return;
  }

  setStatus("Opening the realtime socket…");
  connectSocket(tokenData);
}

function connectSocket(tokenData) {
  const socket = new WebSocket(
    `${WS_URL}?token=${encodeURIComponent(tokenData.access_token)}`
  );
  state.ws = socket;
  state.ending = false;

  socket.addEventListener("open", () => {
    logWire("sys", "socket.open", "wss://api.smallest.ai/atoms/v1/agent/connect");
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      logWire("in", "invalid.json", String(event.data).slice(0, 120), true);
      return;
    }
    handleServerMessage(message);
  });

  socket.addEventListener("error", () => {
    logWire("err", "socket.error", "handshake or network failure", true);
    setStatus("The socket failed. Check the key, agent id, and network.");
    setPill("Error", "error");
  });

  socket.addEventListener("close", (event) => {
    logWire("sys", "socket.close", `code ${event.code}${event.reason ? ` · ${event.reason}` : ""}`);
    if (!state.ending) {
      setStatus(`Call closed (${event.code || "no code"}).`);
    }
    teardownCall();
  });
}

function handleServerMessage(message) {
  switch (message.type) {
    case "session.created": {
      state.session = message;
      state.connected = true;
      const shortId = message.call_id || message.session_id;
      els.sessionValue.textContent = shortId;
      els.sessionValue.title = `session ${message.session_id}\ncall ${message.call_id}`;
      logWire(
        "in",
        "session.created",
        `${message.input_audio_format} → ${message.output_audio_format} · ${message.sample_rate} Hz`
      );
      state.inputRow = logWire("out", "input_audio_buffer.append", "waiting for microphone…");
      setPill("Live", "live");
      setLiveControls(true);
      setStatus("Live. Speak naturally — try talking over the agent to test barge-in.");
      startTimer();
      break;
    }

    case "output_audio.delta": {
      playAudio(message.audio);
      noteOutputAudio(message.audio);
      break;
    }

    case "transcript.delta": {
      if (message.role === "assistant") {
        state.agentTalking = true;
      } else {
        state.assistantContinuation = false;
      }
      upsertBubble(message.role, message.text, false);
      noteTranscript(message.role, "transcript.delta");
      break;
    }

    case "transcript": {
      upsertBubble(message.role, message.text, true);
      if (message.role === "user") {
        state.userFinalAt = performance.now();
        state.ttfbPending = true;
      }
      state.lastNote = null;
      logWire("in", "transcript", `${message.role}: ${truncate(message.text, 90)}`);
      break;
    }

    case "agent_start_talking": {
      state.agentTalking = true;
      state.assistantContinuation = false;
      state.liveBubbles.assistant = null;
      state.turnStart = performance.now();
      els.orb.classList.add("talking");
      els.orb.classList.remove("listening");
      state.audioRow = null;
      logWire("in", "agent_start_talking", "");
      break;
    }

    case "agent_stop_talking": {
      state.agentTalking = false;
      els.orb.classList.remove("talking");
      if (state.connected) els.orb.classList.add("listening");
      if (state.turnStart) {
        const seconds = (performance.now() - state.turnStart) / 1000;
        els.turnValue.textContent = `${seconds.toFixed(2)}s`;
        state.turnStart = 0;
      }
      state.audioRow = null;
      logWire("in", "agent_stop_talking", "");
      break;
    }

    case "interruption": {
      stopPlayback();
      state.agentTalking = false;
      state.assistantContinuation = false;
      els.orb.classList.remove("talking");
      els.orb.classList.add("listening");
      markLastAssistantInterrupted();
      logWire("in", "interruption", "barge-in — playback stopped", false);
      setStatus("Barge-in detected — the agent stopped talking.");
      break;
    }

    case "function_call": {
      handleFunctionCall(message);
      break;
    }

    case "error": {
      logWire("err", "error", `[${message.code}] ${message.message}`, true);
      showToast(`[${message.code}] ${message.message}`);
      break;
    }

    case "session.closed": {
      logWire("in", "session.closed", message.reason);
      state.ending = true;
      teardownCall();
      setStatus(`Call ended (${message.reason}).`);
      break;
    }

    default: {
      logWire("in", message.type || "unknown", "");
    }
  }
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

async function ensureAudio() {
  if (!state.ctx) {
    try {
      state.ctx = new AudioContext({ sampleRate: IN_RATE, latencyHint: "interactive" });
    } catch {
      state.ctx = new AudioContext();
    }

    await state.ctx.audioWorklet.addModule("/pcm-worklet.js");

    state.outGain = state.ctx.createGain();
    state.outAnalyser = state.ctx.createAnalyser();
    state.outAnalyser.fftSize = 512;
    state.outAnalyser.smoothingTimeConstant = 0.78;
    state.outGain.connect(state.outAnalyser);
    state.outAnalyser.connect(state.ctx.destination);

    // Keeps the worklet alive without echoing the mic to the speakers.
    state.silentGain = state.ctx.createGain();
    state.silentGain.gain.value = 0;
    state.silentGain.connect(state.ctx.destination);
  }

  if (state.ctx.state !== "running") {
    await state.ctx.resume();
  }
}

async function startMicrophone() {
  if (state.worklet) return;

  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  state.micSource = state.ctx.createMediaStreamSource(state.stream);

  state.inAnalyser = state.ctx.createAnalyser();
  state.inAnalyser.fftSize = 512;
  state.inAnalyser.smoothingTimeConstant = 0.75;
  state.micSource.connect(state.inAnalyser);

  state.worklet = new AudioWorkletNode(state.ctx, "pcm-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
  });

  state.worklet.port.onmessage = (event) => {
    if (state.muted || !state.connected) return;
    sendAudioFrame(event.data);
  };

  state.micSource.connect(state.worklet);
  state.worklet.connect(state.silentGain);
}

function stopMicrophone() {
  try { state.worklet?.disconnect(); } catch { /* ignore */ }
  try { state.micSource?.disconnect(); } catch { /* ignore */ }
  state.worklet = null;
  state.micSource = null;
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  if (state.inAnalyser) {
    try { state.inAnalyser.disconnect(); } catch { /* ignore */ }
    state.inAnalyser = null;
  }
  state.muted = false;
  updateMuteButton();
}

function sendAudioFrame(float32) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

  const resampled = resample(float32, state.ctx.sampleRate, IN_RATE);
  const pcm16 = floatToInt16(resampled);
  const base64 = base64FromBytes(new Uint8Array(pcm16.buffer));

  state.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64 }));

  state.chunksIn++;
  state.bytesIn += pcm16.byteLength;

  if (state.chunksIn % 10 === 0) {
    els.chunksValue.textContent = String(state.chunksIn);
    if (state.inputRow) {
      state.inputRow.querySelector(".meta").textContent =
        `${formatBytes(state.bytesIn)} · ${state.chunksIn} frames`;
    }
  }
}

function playAudio(base64) {
  if (!state.ctx) return;
  const bytes = bytesFromBase64(base64);
  if (bytes.byteLength < 2) return;

  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const float = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) float[i] = pcm[i] / 32768;

  const sampleRate = state.session?.sample_rate || IN_RATE;
  const buffer = state.ctx.createBuffer(1, float.length, sampleRate);
  buffer.copyToChannel(float, 0);

  const source = state.ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(state.outGain);

  const now = state.ctx.currentTime;
  const startAt = Math.max(now + 0.035, state.nextPlayTime);
  source.start(startAt);
  state.nextPlayTime = startAt + buffer.duration;

  state.sources.add(source);
  source.onended = () => state.sources.delete(source);

  if (state.ttfbPending && state.userFinalAt) {
    const ms = Math.round(performance.now() - state.userFinalAt);
    state.userFinalAt = 0;
    state.ttfbPending = false;
    state.ttfbSamples.push(ms);
    els.ttfbValue.textContent = `${ms} ms`;
    const average = Math.round(
      state.ttfbSamples.reduce((sum, value) => sum + value, 0) / state.ttfbSamples.length
    );
    els.ttfbValue.title = `last ${ms} ms · average ${average} ms over ${state.ttfbSamples.length} turn${state.ttfbSamples.length > 1 ? "s" : ""}`;
  }
}

function stopPlayback() {
  for (const source of state.sources) {
    try { source.stop(); } catch { /* already stopped */ }
  }
  state.sources.clear();
  state.nextPlayTime = 0;
}

function noteOutputAudio(base64) {
  state.audioFrames++;
  const bytes = Math.floor((base64.length * 3) / 4);
  state.audioBytes += bytes;

  if (!state.audioRow) {
    state.audioRow = logWire("in", "output_audio.delta", `${formatBytes(bytes)} · frame 1`);
  } else if (state.audioFrames % 8 === 0 && state.audioRow) {
    state.audioRow.querySelector(".meta").textContent =
      `${formatBytes(state.audioBytes)} · ${state.audioFrames} frames`;
  }
}

function toggleMute() {
  state.muted = !state.muted;
  updateMuteButton();
  setStatus(
    state.muted
      ? "Microphone muted. The agent is still listening to silence."
      : "Microphone live."
  );
  logWire("sys", state.muted ? "mic.muted" : "mic.unmuted", "");
}

function updateMuteButton() {
  els.muteBtn.classList.toggle("on", state.muted);
  els.muteBtn.textContent = state.muted ? "🔇 Muted" : "🎙 Mute";
}

// ---------------------------------------------------------------------------
// Text + tools
// ---------------------------------------------------------------------------

function sendText() {
  const text = els.textInput.value.trim();
  if (!text) return;
  if (!state.connected || !state.ws) {
    showToast("Start a call first.");
    return;
  }
  state.ws.send(JSON.stringify({ type: "input_text.send", text }));
  logWire("out", "input_text.send", truncate(text, 80));
  addSystemLine("you typed", text);
  els.textInput.value = "";
}

async function handleFunctionCall(message) {
  const name = message.name;
  let args = {};
  try {
    args = JSON.parse(message.arguments || "{}");
  } catch { /* keep {} */ }

  logWire("in", "function_call", `${name}(${truncate(JSON.stringify(args), 80)})`);
  const line = addSystemLine(`tool call · ${name}`, JSON.stringify(args), "running");

  let output;
  try {
    if (name === "get_order_status") {
      const orderId = String(args.order_id || "").trim();
      if (!orderId) {
        output = { error: "missing_order_id", message: "Ask the caller for their order id." };
      } else {
        const res = await fetch(`/api/demo/orders/${encodeURIComponent(orderId)}`);
        output = await res.json();
      }
    } else {
      output = { error: "unknown_tool", message: `No handler for ${name}.` };
    }
  } catch (err) {
    output = { error: "tool_failed", message: err.message };
  }

  const summary =
    output.status ||
    output.message ||
    output.error ||
    "result returned";

  if (line) {
    if (!output.error) line.classList.add("done");
    line.querySelector("b").textContent = output.error ? "tool error" : "tool result";
    line.querySelector("span").textContent = summary;
  }

  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(
      JSON.stringify({
        type: "function_call.result",
        call_id: message.call_id,
        output: JSON.stringify(output),
      })
    );
    logWire("out", "function_call.result", truncate(summary, 60));
  }
}

function addSystemLine(label, text, variant = "") {
  hideEmptyState();
  const line = document.createElement("div");
  line.className = `system-line ${variant}`;

  const bold = document.createElement("b");
  bold.textContent = label;
  const span = document.createElement("span");
  span.textContent = text;

  line.append(bold, span);
  els.transcript.append(line);
  scrollTranscript();
  return line;
}

// ---------------------------------------------------------------------------
// Transcript rendering
// ---------------------------------------------------------------------------

function upsertBubble(role, text, final) {
  hideEmptyState();
  const key = role === "user" ? "user" : "assistant";

  let bubble = state.liveBubbles[key];

  // The server occasionally sends one more delta right after a final
  // transcript. Merge that tail into the sentence instead of starting a new
  // bubble (a new agent turn always emits agent_start_talking first).
  if (!bubble && key === "assistant" && !final && state.assistantContinuation) {
    const last = lastAssistantBubble();
    if (last) {
      const paragraph = last.querySelector("p");
      const current = paragraph.textContent;
      if (text === current) return;
      const joiner =
        /\s$/.test(current) || /^[.,!?;:]/.test(text) ? "" : " ";
      paragraph.textContent = text.startsWith(current)
        ? text
        : `${current}${joiner}${text}`;
      last.classList.remove("interrupted");
      scrollTranscript();
      return;
    }
  }

  if (!bubble) {
    bubble = document.createElement("div");
    bubble.className = `bubble ${key} live`;

    const who = document.createElement("div");
    who.className = "who";
    who.textContent = key === "user" ? "You" : "Agent";

    const paragraph = document.createElement("p");

    bubble.append(who, paragraph);
    els.transcript.append(bubble);
    state.liveBubbles[key] = bubble;
  }

  bubble.querySelector("p").textContent = text;
  bubble.classList.toggle("live", !final);

  if (final) {
    state.liveBubbles[key] = null;
    state.assistantContinuation = key === "assistant";
  }
  scrollTranscript();
}

function lastAssistantBubble() {
  const bubbles = els.transcript.querySelectorAll(".bubble.assistant");
  return bubbles[bubbles.length - 1] || null;
}

function markLastAssistantInterrupted() {
  const last = lastAssistantBubble();
  if (last) {
    last.classList.add("interrupted");
    last.classList.remove("live");
  }
  // Keep the reference so a late final transcript settles this same bubble.
}

function clearTranscript() {
  els.transcript.replaceChildren(els.transcriptEmpty);
  els.transcriptEmpty.hidden = false;
  state.liveBubbles = { user: null, assistant: null };
  state.assistantContinuation = false;
}

function hideEmptyState() {
  els.transcriptEmpty.hidden = true;
}

function scrollTranscript() {
  const distance =
    els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight;
  if (distance < 120) {
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }
}

function noteTranscript(role, type) {
  const key = `${role}:${type}`;
  if (state.lastNote === key) return;
  state.lastNote = key;
  logWire("in", type, `${role}: streaming…`);
}

// ---------------------------------------------------------------------------
// Wire log
// ---------------------------------------------------------------------------

let logRows = 0;

function logWire(dir, type, meta = "", isError = false) {
  const row = document.createElement("div");
  row.className = `wire-row ${dir}${isError ? " err" : ""}`;

  const time = document.createElement("span");
  time.className = "t";
  time.textContent = new Date().toISOString().slice(11, 23);

  const arrow = document.createElement("span");
  arrow.className = "dir";
  arrow.textContent = dir === "in" ? "↓" : dir === "out" ? "↑" : dir === "err" ? "!" : "·";

  const message = document.createElement("span");
  message.className = "msg";

  const typeEl = document.createElement("span");
  typeEl.className = "type";
  typeEl.textContent = type;

  const metaEl = document.createElement("span");
  metaEl.className = "meta";
  metaEl.textContent = meta ? ` ${meta}` : "";

  message.append(typeEl, metaEl);
  row.append(time, arrow, message);
  els.wireLog.append(row);

  logRows++;
  els.logCount.textContent = String(logRows);

  while (els.wireLog.children.length > 220) {
    els.wireLog.firstElementChild.remove();
  }

  const distance =
    els.wireLog.scrollHeight - els.wireLog.scrollTop - els.wireLog.clientHeight;
  if (distance < 80) els.wireLog.scrollTop = els.wireLog.scrollHeight;

  return row;
}

// ---------------------------------------------------------------------------
// Timer + teardown
// ---------------------------------------------------------------------------

function startTimer() {
  state.startedAt = Date.now();
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    const total = Math.floor((Date.now() - state.startedAt) / 1000);
    const minutes = String(Math.floor(total / 60)).padStart(2, "0");
    const seconds = String(total % 60).padStart(2, "0");
    els.callTimer.textContent = `${minutes}:${seconds}`;
  }, 500);
}

function endCall(reason) {
  state.ending = true;
  if (state.ws?.readyState === WebSocket.OPEN) {
    try {
      state.ws.send(JSON.stringify({ type: "session.close" }));
      logWire("out", "session.close", reason);
    } catch { /* ignore */ }
  }
  setTimeout(() => {
    try { state.ws?.close(); } catch { /* ignore */ }
    teardownCall();
  }, 180);
  setStatus("Ending the call…");
}

function teardownCall() {
  const savedCallId =
    state.session?.call_id || state.session?.session_id || null;

  clearInterval(state.timer);
  state.timer = null;
  stopPlayback();
  stopMicrophone();
  state.ws = null;
  state.session = null;
  state.connected = false;
  state.agentTalking = false;
  state.inputRow = null;
  state.audioRow = null;
  state.lastNote = null;
  state.ttfbPending = false;
  setLiveControls(false);
  setPill("Idle");
  if (state.ending) setStatus("Call ended. Start another whenever you like.");
  state.ending = false;
  setStartEnabled(Boolean(state.agent));
  els.callTimer.textContent = "00:00";

  if (savedCallId) {
    showToast("Call saved. Open Call history for the transcript and recording.", true);
    setTimeout(() => {
      loadHistoryCount();
      if (els.historyDialog.open) loadHistory({ reset: true });
    }, 2500);
  }
}

// ---------------------------------------------------------------------------
// Visualizer
// ---------------------------------------------------------------------------

function drawVisualizer() {
  requestAnimationFrame(drawVisualizer);

  const canvas = els.viz;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight || 72;

  if (!width) return;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);

  const bars = state.levels.length;
  const analyser = state.agentTalking ? state.outAnalyser : state.inAnalyser;
  const frequency = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
  if (analyser) analyser.getByteFrequencyData(frequency);

  const time = performance.now() / 1000;
  const gap = 3;
  const barWidth = Math.max(1, (width - gap * (bars - 1)) / bars);

  for (let i = 0; i < bars; i++) {
    let target;
    if (analyser) {
      const bin = Math.min(frequency.length - 1, Math.floor(2 + i * 1.6));
      target = Math.pow(frequency[bin] / 255, 1.55) * 1.15;
    } else {
      const wave =
        0.05 +
        0.05 * Math.sin(time * 1.4 + i * 0.35) +
        0.03 * Math.sin(time * 0.7 + i * 0.9);
      target = Math.abs(wave);
    }

    state.levels[i] += (target - state.levels[i]) * 0.22;
    const value = Math.max(0.02, Math.min(1, state.levels[i]));
    const barHeight = Math.max(2, value * (height - 10));
    const x = i * (barWidth + gap);
    const y = (height - barHeight) / 2;

    const mix = i / bars;
    const r = Math.round(79 + (141 - 79) * mix);
    const gr = Math.round(209 + (156 - 209) * mix);
    const b = Math.round(197 + (255 - 197) * mix);

    g.fillStyle = state.agentTalking
      ? `rgba(255, ${Math.round(196 - i * 1.2)}, ${Math.round(107 + i * 1.5)}, ${0.35 + value * 0.5})`
      : `rgba(${r}, ${gr}, ${b}, ${0.3 + value * 0.55})`;

    g.beginPath();
    const radius = Math.min(barWidth / 2, 2);
    g.roundRect(x, y, barWidth, barHeight, radius);
    g.fill();
  }
}

// ---------------------------------------------------------------------------
// Codec helpers
// ---------------------------------------------------------------------------

function resample(float32, fromRate, toRate) {
  if (fromRate === toRate) return float32;
  const ratio = fromRate / toRate;
  const length = Math.floor(float32.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = float32[index] ?? 0;
    const b = float32[index + 1] ?? a;
    out[i] = a + (b - a) * fraction;
  }
  return out;
}

function floatToInt16(float32) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

function base64FromBytes(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function bytesFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
