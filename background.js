// background.js — OpenCode extension service worker, migrated to the OpenCode v2 HTTP API.
//
// v1 -> v2 in one place. The sidebar still speaks its old message protocol
// ("api-request" with a v1 path, "send-prompt", "subscribe-events"), and this
// worker translates it to v2 and translates v2 events back to the v1 event
// shape the sidebar renders. Keeping the translation here means the sidebar
// bundle does not have to be rewritten.
//
// What changed v1 -> v2 (proven against the running server, see MIGRATION-PLAN):
//   health   GET  /global/health           -> GET  /api/info
//   events   GET  /global/event (SSE)      -> GET  /api/event (SSE), envelope
//                                             {id,type,data} instead of
//                                             {payload:{type,properties}}
//   list     GET  /session                 -> GET  /api/session        -> {data:[...]}
//   create   POST /session                 -> POST /api/session        {title,location,...}
//   msgs     GET  /session/{id}/message    -> GET  /api/session/{id}/message -> {data:[...]}
//   prompt   POST /session/{id}/message    -> POST /api/session/{id}/prompt {id,text}
//   abort    POST /session/{id}/abort      -> POST /api/session/{id}/interrupt
//   rename   PATCH/session/{id}            -> PATCH /api/session/{id} {title}
//   perms    POST /session/{id}/permissions/{p} -> POST /api/session/{id}/permission/{p}/reply {decision}
//   form     POST /question/{q}/reply      -> POST /api/session/{id}/form/{q}/reply {answer}
//   scope    (none)                         -> most routes take ?directory=<cwd>
//
// Auth is unchanged: Authorization: Basic base64("opencode:" + password).

import {
  z as apiDebug,
  o as MSG_API_ERROR,
  p as MSG_API_RESPONSE,
  r as MSG_HEALTH_OK,
  q as MSG_HEALTH_FAIL,
  A as eventsDebug,
  j as MSG_EVENT,
  B as promptDebug,
  f as MSG_PROMPT_ERROR,
  h as MSG_PROMPT_DONE,
  i as MSG_PROMPT_CHUNK,
  b as browser,
  m as MSG_ACTIVE_TAB_CHANGED,
  n as MSG_TABS_LIST,
  l as MSG_TAB_CONTENT,
  k as MSG_TAB_CONTENT_ERROR,
  C as MSG_TABS_ERROR,
  M as MSG_SET_DEVELOPER_MODE,
  e as enableDebug,
  d as disableDebug,
  y as MSG_ABORT_PROMPT,
  v as MSG_SEND_PROMPT,
  x as MSG_UNSUBSCRIBE_EVENTS,
  w as MSG_SUBSCRIBE_EVENTS,
  u as MSG_EXTRACT_TAB_CONTENT,
  t as MSG_GET_TABS,
  a as MSG_API_REQUEST,
  c as MSG_HEALTH_CHECK,
} from "./assets/protocol-B0G2vb7g.js";

const DEFAULT_SERVER = "http://localhost:49376";
const API_PREFIX = "/api";

// ---------------------------------------------------------------------------
// logging — everything goes to the service-worker console AND to a bounded ring
// buffer in chrome.storage.local under "ocLogs", so the logs survive the worker
// being killed and can be read from any extension page with
// chrome.storage.local.get("ocLogs"). Shape: {t, level, msg, data}.
// ---------------------------------------------------------------------------
const LOG_RING = 1000;
let logBuffer = [];
let logFlushTimer = null;
let logReady = false;

function fmt(data) {
  if (data === undefined) return "";
  try {
    return typeof data === "string" ? data : JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function writeLog(level, msg, data) {
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    data: data === undefined ? undefined : fmt(data).slice(0, 2000),
  };
  // console for live devtools
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(`[oc-bg ${line.t}] ${level.toUpperCase()} ${msg}`, data === undefined ? "" : data);
  logBuffer.push(line);
  if (logBuffer.length > LOG_RING) logBuffer.splice(0, logBuffer.length - LOG_RING);
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    const toWrite = logBuffer.slice(-LOG_RING);
    browser.storage.local.set({ ocLogs: toWrite }).catch(() => {});
  }, 400);
}

const log = (msg, data) => writeLog("info", msg, data);
const warn = (msg, data) => writeLog("warn", msg, data);
const errlog = (msg, data) => writeLog("error", msg, data);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function serverOf(message) {
  return (message && message.serverUrl) || DEFAULT_SERVER;
}

function authOf(message) {
  return message && message.auth ? { Authorization: message.auth } : {};
}

// v2 message IDs are `msg_` + 26 base62 chars. The server validates the prefix
// (`Session.Message.ID` = check("msg_")), so a bare crypto.randomUUID() is
// rejected with: Expected a string starting with "msg_".
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function newMessageId() {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return `msg_${s}`;
}

async function workspaceDirectory() {
  try {
    const stored = await browser.storage.local.get(["workspacePath"]);
    const dir = stored && stored.workspacePath;
    return typeof dir === "string" && dir ? dir : "";
  } catch (e) {
    warn("workspaceDirectory read failed", String(e));
    return "";
  }
}

// Append ?directory= to a path when we know the workspace, so v2 scopes the
// call to the right project. Kept separate so it is easy to see in the logs.
function withDirectory(path, dir) {
  if (!dir) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}directory=${encodeURIComponent(dir)}`;
}

// ---------------------------------------------------------------------------
// v1 -> v2 path translation. The sidebar sends v1 paths; they are rewritten
// here. Anything not listed is passed through with the /api prefix.
// ---------------------------------------------------------------------------
function translatePath(rawPath, method, options) {
  let path = rawPath || "";
  // strip any accidental v1 prefix forms
  if (path === "/session") return method === "POST" ? `${API_PREFIX}/session` : `${API_PREFIX}/session`;
  if (path.startsWith("/session/")) {
    const rest = path.slice("/session/".length);
    const [id, ...tail] = rest.split("/");
    const sub = tail.join("/");
    if (!sub) return `${API_PREFIX}/session/${id}`;
    if (sub === "message") return `${API_PREFIX}/session/${id}/message`;
    if (sub === "abort") return `${API_PREFIX}/session/${id}/interrupt`;
    if (sub.startsWith("permissions/")) {
      const pid = sub.slice("permissions/".length);
      return `${API_PREFIX}/session/${id}/permission/${pid}/reply`;
    }
    return `${API_PREFIX}/session/${id}/${sub}`;
  }
  if (path.startsWith("/question/")) {
    const qid = path.slice("/question/".length).replace(/\/reply$/, "");
    const sid = subscribedSessionId || (options && options.sessionId) || "";
    return `${API_PREFIX}/session/${sid}/form/${qid}/reply`;
  }
  if (path.startsWith(API_PREFIX)) return path; // already v2
  return `${API_PREFIX}${path.startsWith("/") ? "" : "/"}${path}`;
}

// Body translation for the few calls whose shape changed.
function translateBody(rawPath, method, bodyString) {
  if (!bodyString) return bodyString;
  let body;
  try {
    body = JSON.parse(bodyString);
  } catch {
    return bodyString;
  }
  if (rawPath === "/session" && method === "POST") {
    // v2 create body
    return JSON.stringify({ ...body });
  }
  if (/^\/session\/[^/]+\/permissions\//.test(rawPath)) {
    return JSON.stringify({ decision: body.response });
  }
  if (rawPath.startsWith("/question/")) {
    return JSON.stringify({ answer: body.answers });
  }
  return bodyString;
}

// Unwrap the v2 envelopes. Most v2 list routes answer {data:[...]}; some add
// {location:{directory}, data}. The sidebar expects the bare value.
function unwrap(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if ("data" in payload) return payload.data;
  }
  return payload;
}

// v2 message -> the shape the sidebar renders ({role, parts:[{type,text}], info}).
function mapMessage(m) {
  if (!m || typeof m !== "object") return m;
  const parts = Array.isArray(m.content)
    ? m.content.map((p) => {
        if (!p || typeof p !== "object") return p;
        if (p.type === "reasoning") return { type: "reasoning", text: p.text || "" };
        if (p.type === "text") return { type: "text", text: p.text || "" };
        if (p.type === "tool" || p.type === "tool-call" || p.tool) {
          return {
            type: "tool",
            name: (p.tool && p.tool.name) || p.name || p.toolName || "tool",
            state: p.state || (p.tool && p.tool.state),
            input: p.input || (p.tool && p.tool.input) || {},
          };
        }
        return p;
      })
    : [];
  return {
    role: m.type === "user" ? "user" : "assistant",
    parts,
    info: {
      id: m.id,
      role: m.type,
      modelID: (m.model && m.model.id) || undefined,
      agent: m.agent,
      time: m.time,
    },
    raw: m,
  };
}

// ---------------------------------------------------------------------------
// health  — GET /api/info
// ---------------------------------------------------------------------------
async function handleHealthCheck(port, message) {
  const base = serverOf(message);
  const url = `${base}${API_PREFIX}/info`;
  log("health-check -> GET", url);
  try {
    const res = await fetch(url, { headers: { ...authOf(message) } });
    const text = await res.text();
    log("health-check <- status", { status: res.status, contentType: res.headers.get("content-type"), body: text.slice(0, 200) });
    if (!res.ok) {
      port.postMessage({ type: MSG_HEALTH_FAIL, error: `HTTP ${res.status}`, body: text.slice(0, 200) });
      return;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      port.postMessage({ type: MSG_HEALTH_FAIL, error: "not JSON", body: text.slice(0, 200) });
      return;
    }
    port.postMessage({ type: MSG_HEALTH_OK, data });
  } catch (err) {
    errlog("health-check threw", String(err));
    port.postMessage({ type: MSG_HEALTH_FAIL, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// generic API proxy  — v1 path in, v2 path out, envelope unwrapped
// ---------------------------------------------------------------------------
async function handleApiRequest(port, message) {
  const base = serverOf(message);
  const method = ((message.options && message.options.method) || "GET").toUpperCase();
  let path = translatePath(message.path, method, message.options);
  const dir = await workspaceDirectory();
  path = withDirectory(path, dir);
  const url = `${base}${path}`;
  const body = translateBody(message.path, method, message.options && message.options.body);
  const headers = {
    "Content-Type": "application/json",
    ...authOf(message),
    ...((message.options && message.options.headers) || {}),
  };
  log(`api -> ${method} ${message.path}  =>  ${path}`, body ? { body: fmt(body).slice(0, 300) } : undefined);
  try {
    const res = await fetch(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body });
    const raw = await res.text();
    log(`api <- ${res.status} ${path}`, raw.slice(0, 300));
    const ctype = res.headers.get("content-type") || "";
    let payload = null;
    if (ctype.includes("application/json") && raw) {
      payload = JSON.parse(raw);
    } else if (raw) {
      payload = raw;
    }
    if (!res.ok) {
      port.postMessage({ type: MSG_API_ERROR, id: message.id, error: `HTTP ${res.status}: ${raw.slice(0, 200)}` });
      return;
    }
    let data = unwrap(payload);
    // Message lists get remapped to the sidebar's message shape.
    if (/\/message(\?|$)/.test(path) && Array.isArray(data)) {
      data = data.map(mapMessage);
    }
    port.postMessage({ type: MSG_API_RESPONSE, id: message.id, data });
  } catch (err) {
    errlog("api threw", { path, error: String(err) });
    port.postMessage({ type: MSG_API_ERROR, id: message.id, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// SSE  — GET /api/event, envelope {id,type,data}, translated back to the v1
// {payload:{type,properties}} shape the sidebar renders.
// ---------------------------------------------------------------------------
let sseAbortController = null;
let subscribedSessionId = null;
let sidebarPort = null;
const textByMessage = new Map(); // assistantMessageID -> accumulated text
// v2 has NO `message.updated` event (only session.step.*/session.text.*), so the
// sidebar never learns that a streaming message is the assistant's, and it drops
// every text part whose messageID it does not already know as "assistant".
// We synthesise that announcement once per assistant message.
const announcedMessages = new Set();

function setSidebarPort(port) {
  sidebarPort = port;
}

function postToSidebar(msg) {
  if (sidebarPort) sidebarPort.postMessage(msg);
}

function subscribeEvents(sessionId) {
  log("subscribe-events", sessionId);
  subscribedSessionId = sessionId;
  if (!sseAbortController) connectSSE();
}

function unsubscribeEvents() {
  log("unsubscribe-events");
  subscribedSessionId = null;
  textByMessage.clear();
  announcedMessages.clear();
}

// Announce the assistant message's role to the sidebar the first time we see its
// id, using the RAW v2 event (buildV1Event loses assistantMessageID on some
// mappings). Runs before forwardEvent so the role is known before any delta.
function announceMessage(parsed) {
  const d = (parsed && parsed.data) || {};
  const mid = d.assistantMessageID || (d.messageID && /^msg_/.test(d.messageID) ? d.messageID : "");
  if (!mid || announcedMessages.has(mid)) return;
  const sid = d.sessionID || subscribedSessionId || "";
  if (sid && subscribedSessionId && sid !== subscribedSessionId) return;
  announcedMessages.add(mid);
  postToSidebar({
    type: MSG_EVENT,
    event: {
      payload: {
        type: "message.updated",
        properties: { sessionID: sid, info: { id: mid, role: "assistant" } },
      },
    },
  });
}

function buildV1Event(ev) {
  const type = ev && ev.type;
  const d = (ev && ev.data) || {};
  const sessionID = d.sessionID || subscribedSessionId || "";
  const base = { sessionID };
  const wrap = (v1type, properties) => ({ payload: { type: v1type, properties: { ...base, ...properties } } });

  switch (type) {
    case "server.connected":
      return { payload: { type: "server.connected", properties: {} } };

    case "session.step.started":
      return wrap("session.status", { status: { type: "busy" } });

    case "session.text.delta": {
      const key = d.assistantMessageID || "assistant";
      const next = (textByMessage.get(key) || "") + (d.delta || "");
      textByMessage.set(key, next);
      return wrap("message.part.updated", {
        part: { type: "text", text: next, messageID: d.assistantMessageID },
      });
    }
    case "session.text.ended": {
      const key = d.assistantMessageID || "assistant";
      textByMessage.set(key, d.text || "");
      return wrap("message.part.updated", {
        part: { type: "text", text: d.text || "", messageID: d.assistantMessageID },
      });
    }

    case "session.tool.called":
      return wrap("message.part.updated", {
        part: {
          type: "tool",
          name: d.name || d.toolName || (d.tool && d.tool.name) || "tool",
          state: "running",
          input: d.input || (d.tool && d.tool.input) || {},
          messageID: d.assistantMessageID,
        },
      });
    case "session.tool.success":
      return wrap("message.part.updated", {
        part: { type: "tool", name: d.name || (d.tool && d.tool.name) || "tool", state: "completed", input: d.input || {}, messageID: d.assistantMessageID },
      });
    case "session.tool.failed":
      return wrap("message.part.updated", {
        part: { type: "tool", name: d.name || (d.tool && d.tool.name) || "tool", state: "error", input: d.input || {}, messageID: d.assistantMessageID },
      });

    case "session.step.ended":
      return wrap("message.updated", {
        info: { id: d.assistantMessageID, role: "assistant", modelID: d.modelID || (d.model && d.model.id), cost: d.cost, tokens: d.tokens },
      });

    case "session.reasoning.delta":
      return wrap("message.part.updated", {
        part: { type: "reasoning", text: d.delta || "", messageID: d.assistantMessageID },
      });

    case "permission.asked":
      return wrap("permission.asked", {
        id: d.id,
        permission: d.action || d.permission,
        patterns: d.resources || d.patterns,
        metadata: d.metadata,
        tool: d.tool,
      });
    case "permission.replied":
      return wrap("permission.replied", { id: d.id });

    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return wrap("session.idle", {
        outcome: type.endsWith("succeeded") ? "succeeded" : type.endsWith("failed") ? "failed" : "interrupted",
        error: d.error,
      });

    case "session.deleted":
      return wrap("session.deleted", {});
    case "session.renamed":
    case "session.updated":
      return wrap("session.updated", {});
    case "session.compaction.started":
      return wrap("session.compacted", {});
    default:
      // pass unknown events through so we can see them in the sidebar logs
      return { payload: { type, properties: { ...base, data: d } } };
  }
}

function forwardEvent(ev) {
  if (!ev || !ev.payload) return;
  const props = ev.payload.properties || {};
  const sid = props.sessionID;
  if (sid && subscribedSessionId && sid !== subscribedSessionId) {
    return; // another session's traffic
  }
  eventsDebug("forward v2->v1: %s", ev.payload.type);
  postToSidebar({ type: MSG_EVENT, event: ev });
  if (ev.payload.type === "session.idle") {
    postToSidebar({ type: MSG_PROMPT_DONE, id: 0 });
  }
}

function connectSSE() {
  if (sseAbortController) sseAbortController.abort();
  const controller = new AbortController();
  sseAbortController = controller;
  const base = currentServerUrl();
  const url = `${base}${API_PREFIX}/event`;
  log("SSE connecting", url);
  const read = async () => {
    try {
      const res = await fetch(url, { headers: { Accept: "text/event-stream", ...currentAuth() }, signal: controller.signal });
      log("SSE response", { status: res.status, type: res.headers.get("content-type") });
      if (!res.ok) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          const v1 = buildV1Event(parsed);
          if (v1 && parsed.type !== "server.connected") {
            if (parsed.type && /session\.|permission\.|server\./.test(parsed.type)) {
              log("event", parsed.type);
            }
          }
          announceMessage(parsed);
          forwardEvent(v1);
        }
      }
    } catch (e) {
      if (e.name !== "AbortError" && !controller.signal.aborted) {
        warn("SSE error, reconnecting in 3s", e.message);
        setTimeout(connectSSE, 3000);
      }
    }
  };
  read();
}

// The SSE loop needs the server + auth that the sidebar last used. They arrive
// on health-check / api-request / send-prompt; kept here so connectSSE can use
// them without a message.
let lastServerUrl = DEFAULT_SERVER;
let lastAuth = null;
function currentServerUrl() {
  return lastServerUrl || DEFAULT_SERVER;
}
function currentAuth() {
  return lastAuth ? { Authorization: lastAuth } : {};
}
function remember(message) {
  if (message && message.serverUrl) lastServerUrl = message.serverUrl;
  if (message && message.auth) lastAuth = message.auth;
}

// ---------------------------------------------------------------------------
// prompt  — POST /api/session/{id}/prompt {id,text}. The answer streams on
// /api/event, not on this response.
// ---------------------------------------------------------------------------
let activePrompt = null;

async function handleSendPrompt(port, message) {
  const base = serverOf(message);
  const sessionId = message.sessionId || "";
  const text = message.text || "";
  const dir = await workspaceDirectory();
  const path = withDirectory(`${API_PREFIX}/session/${sessionId}/prompt`, dir);
  const url = `${base}${path}`;
  const body = { id: newMessageId(), text };
  if (message.system) body.metadata = { system: message.system };
  log("prompt -> POST", { url, sessionId, text: text.slice(0, 120) });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authOf(message) },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    log("prompt <- status", { status: res.status, body: raw.slice(0, 300) });
    if (!res.ok) {
      port.postMessage({ type: MSG_PROMPT_ERROR, id: message.id, error: `HTTP ${res.status}: ${raw.slice(0, 200)}` });
      return;
    }
    // The reply arrives via /api/event; make sure we are subscribed to this session.
    subscribedSessionId = sessionId;
    if (!sseAbortController) connectSSE();
    // Some servers may answer with the assistant message inline; forward it if so.
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {}
    if (payload) {
      const data = unwrap(payload);
      if (data && data.content) {
        const m = mapMessage(data);
        postToSidebar({ type: MSG_PROMPT_CHUNK, chunk: (m.parts.find((p) => p.type === "text") || {}).text || "" });
      }
      port.postMessage({ type: MSG_PROMPT_DONE, id: message.id, modelID: (data && data.model && data.model.id) || undefined });
    }
  } catch (err) {
    errlog("prompt threw", String(err));
    port.postMessage({ type: MSG_PROMPT_ERROR, id: message.id, error: err.message });
  }
}

function abortPrompt() {
  const sessionId = subscribedSessionId;
  log("abort-prompt -> interrupt", sessionId);
  if (activePrompt) {
    activePrompt.abort();
    activePrompt = null;
  }
  if (!sessionId) return;
  const url = `${currentServerUrl()}${API_PREFIX}/session/${sessionId}/interrupt`;
  fetch(url, { method: "POST", headers: { ...currentAuth() } })
    .then((r) => log("interrupt <- status", r.status))
    .catch((e) => errlog("interrupt failed", String(e)));
}

// ---------------------------------------------------------------------------
// tabs (unchanged v1 behaviour)
// ---------------------------------------------------------------------------
const internalPrefixes = ["about:", "moz-extension:", "chrome://", "chrome-extension:"];
function isInternalUrl(url) {
  if (!url) return true;
  return internalPrefixes.some((p) => url.startsWith(p));
}
let tabUpdateTimer = null;
function filterTabs(tabs) {
  return tabs.filter((t) => t.url && !isInternalUrl(t.url));
}
async function sendTabs() {
  if (!sidebarPort) return;
  try {
    const tabs = await browser.tabs.query({});
    sidebarPort.postMessage({ type: MSG_TABS_LIST, tabs: filterTabs(tabs) });
  } catch (err) {
    errlog("sendTabs failed", String(err));
  }
}
function scheduleTabUpdate() {
  if (tabUpdateTimer) clearTimeout(tabUpdateTimer);
  tabUpdateTimer = setTimeout(sendTabs, 500);
}
async function handleGetTabs(port) {
  try {
    const tabs = await browser.tabs.query({});
    port.postMessage({ type: MSG_TABS_LIST, tabs: filterTabs(tabs) });
  } catch (err) {
    port.postMessage({ type: MSG_TABS_ERROR, error: err.message });
  }
}
async function handleExtractTabContent(port, tabId) {
  try {
    const results = await browser.tabs.sendMessage(tabId, { type: "extract-content" });
    port.postMessage({ type: MSG_TAB_CONTENT, tabId, content: results });
  } catch {
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: ["content/extract.js"] });
      const results = await browser.tabs.sendMessage(tabId, { type: "extract-content" });
      port.postMessage({ type: MSG_TAB_CONTENT, tabId, content: results });
    } catch (err) {
      port.postMessage({ type: MSG_TAB_CONTENT_ERROR, tabId, error: err.message });
    }
  }
}
function setupTabListeners() {
  browser.tabs.onRemoved.addListener(scheduleTabUpdate);
  browser.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.status === "complete") scheduleTabUpdate();
  });
  browser.tabs.onActivated.addListener(async (activeInfo) => {
    if (!sidebarPort) return;
    sidebarPort.postMessage({ type: MSG_ACTIVE_TAB_CHANGED, tabId: activeInfo.tabId });
  });
  browser.windows.onFocusChanged.addListener(async (windowId) => {
    if (!sidebarPort || windowId < 0) return;
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0) sidebarPort.postMessage({ type: MSG_ACTIVE_TAB_CHANGED, tabId: tabs[0].id });
    } catch (err) {
      errlog("window focus tabs failed", String(err));
    }
  });
}

// ---------------------------------------------------------------------------
// message router
// ---------------------------------------------------------------------------
async function handleMessage(port, message) {
  remember(message);
  switch (message.type) {
    case MSG_HEALTH_CHECK:
      await handleHealthCheck(port, message);
      break;
    case MSG_API_REQUEST:
      await handleApiRequest(port, message);
      break;
    case MSG_GET_TABS:
      await handleGetTabs(port);
      break;
    case MSG_EXTRACT_TAB_CONTENT:
      if (message.tabId !== undefined) await handleExtractTabContent(port, message.tabId);
      break;
    case MSG_SUBSCRIBE_EVENTS:
      if (message.sessionId) subscribeEvents(message.sessionId);
      break;
    case MSG_UNSUBSCRIBE_EVENTS:
      unsubscribeEvents();
      break;
    case MSG_SEND_PROMPT:
      await handleSendPrompt(port, message);
      break;
    case MSG_ABORT_PROMPT:
      abortPrompt();
      break;
    case MSG_SET_DEVELOPER_MODE:
      if (message.enabled) enableDebug();
      else disableDebug();
      break;
    default:
      log("unhandled message", message.type);
  }
}

function setupPortListener() {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== "opencode-sidebar") return;
    log("sidebar connected");
    setSidebarPort(port);
    port.onDisconnect.addListener(() => {
      log("sidebar disconnected");
      setSidebarPort(null);
      // keep the SSE stream: the side panel can be reopened without a full resubscribe
    });
    port.onMessage.addListener((message) => {
      handleMessage(port, message).catch((e) => errlog("handleMessage threw", String(e)));
    });
    sendTabs();
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
(async () => {
  try {
    const stored = await browser.storage.local.get(["ocLogs"]);
    if (stored && Array.isArray(stored.ocLogs)) logBuffer = stored.ocLogs.slice(-LOG_RING);
  } catch {}
  log("service worker booted", { version: "v2-migration", server: currentServerUrl() });
  logReady = true;
})();

setupPortListener();
setupTabListeners();

// expose for manual debugging from a worker console
globalThis.__ocBg = { log, warn, errlog, buildV1Event, translatePath, connectSSE, logs: () => logBuffer };
