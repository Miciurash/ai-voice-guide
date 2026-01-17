export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. ROUTE: Serve the Web Component Script
    if (url.pathname === "/guide.js") {
      return new Response(generateWidgetScript(url.origin), {
        headers: {
          "Content-Type": "application/javascript",
          "Access-Control-Allow-Origin": "*"
        },
      });
    }

    // 2. ROUTE: Secure WebSocket Proxy
    if (request.headers.get("Upgrade") === "websocket") {
      const geminiKey = env.GEMINI_API_KEY;
      if (!geminiKey) {
        return new Response("Missing GEMINI_API_KEY", { status: 500 });
      }
      // Security: Replace with your actual domain(s)
      const origin = request.headers.get("Origin");
      console.log("WebSocket connection attempt from origin:", origin);
      if (origin && origin !== "null" && !origin.startsWith("file://") && !origin.includes("localhost") && !origin.includes("yourdomain.com")) {
        return new Response("Unauthorized", { status: 403 });
      }

      // Live API WebSockets (v1beta)
      // Ref: https://ai.google.dev/api/live
      const googleUrl =
        `https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${geminiKey}`;
      console.log("Connecting to Google:", googleUrl.substring(0, 80) + "...");

      const headers = new Headers();
      headers.set("Upgrade", "websocket");
      headers.set("Connection", "Upgrade");
      headers.set("Sec-WebSocket-Version", "13");
      const protocol = request.headers.get("Sec-WebSocket-Protocol");
      if (protocol) headers.set("Sec-WebSocket-Protocol", protocol);
      const originHeader = request.headers.get("Origin");
      if (originHeader) headers.set("Origin", originHeader);

      // Optional: Pass other specific headers if needed, but avoid Host/Origin

      try {
        const response = await fetch(googleUrl, { headers });
        console.log("Google response status:", response.status);
        if (response.status !== 101 || !response.webSocket) {
          const text = await response.text().catch(() => "");
          console.log("Upstream error body:", text);
          return new Response(text || "Upstream did not upgrade.", { status: response.status || 502 });
        }

        const upstream = response.webSocket;
        upstream.accept();

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.accept();

        const toValidCloseCode = (code) => {
          const n = Number(code);
          // Reserved/invalid close codes in WebSocket protocol.
          const reserved = new Set([1005, 1006, 1015]);
          if (!Number.isFinite(n) || n < 1000 || n > 4999 || reserved.has(n)) return 1000;
          return n;
        };

        const closeIfOpen = (socket, code, reason) => {
          if (!socket) return;
          if (socket.readyState === 0 || socket.readyState === 1) {
            socket.close(toValidCloseCode(code), reason);
          }
        };

        server.addEventListener("message", (event) => {
          if (upstream.readyState === 1) upstream.send(event.data);
        });
        upstream.addEventListener("message", (event) => {
          if (server.readyState === 1) server.send(event.data);
        });
        server.addEventListener("close", (event) => {
          closeIfOpen(upstream, event.code, event.reason);
        });
        upstream.addEventListener("close", (event) => {
          closeIfOpen(server, event.code, event.reason);
        });
        server.addEventListener("error", () => {
          closeIfOpen(upstream, 1011, "Client socket error");
        });
        upstream.addEventListener("error", () => {
          closeIfOpen(server, 1011, "Upstream socket error");
        });

        return new Response(null, { status: 101, webSocket: client });
      } catch (e) {
        console.error("Fetch failed:", e);
        return new Response(e.message, { status: 502 });
      }
    }

    return new Response("Voice Guide Worker is Active", { status: 200 });
  },
};

// This function contains the entire Web Component code
function generateWidgetScript(workerBaseUrl) {
  // Convert https to wss, or http to ws for local dev
  const wsUrl = workerBaseUrl.replace("https://", "wss://").replace("http://", "ws://") + "/ws";

  return `
class VoiceGuide extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.audioCtx = null;
    this.socket = null;
    this.nextPlayTime = 0;
    this.micStream = null;
    this.workletNode = null;
    this.hasGreeted = false;
    this.config = null;
    this.lastAudioAt = 0;
    this._setupComplete = false;
    this._afterSetupQueue = [];
  }

  getConfig() {
    if (this.config) return this.config;
    const globalConfig = typeof window !== "undefined" ? (window.VOICE_GUIDE_CONFIG || {}) : {};
    const greeting = typeof globalConfig.greeting === "string"
      ? globalConfig.greeting
      : (typeof window !== "undefined" && typeof window.VOICE_GUIDE_GREETING === "string"
        ? window.VOICE_GUIDE_GREETING
        : "Start speaking now. Introduce yourself in one short sentence and ask how you can help.");
    const autoGreet = globalConfig.autoGreet !== undefined ? Boolean(globalConfig.autoGreet) : true;
    const voiceName = typeof globalConfig.voiceName === "string" ? globalConfig.voiceName : "Kore";
    const model = typeof globalConfig.model === "string"
      ? globalConfig.model
      // Matches the official mic-stream Live API example (updated 2025-12-22)
      : "gemini-2.5-flash-native-audio-preview-12-2025";
    const systemInstruction = typeof globalConfig.systemInstruction === "string"
      ? globalConfig.systemInstruction
      : "You are a helpful, concise voice assistant for this website. You can control the page using tools. When the user asks to interact with the UI (click buttons, fill fields, select options, check checkboxes, press keys, open links, scroll, etc.), you MUST call the appropriate tool instead of only describing what to do. Use agent_browser.snapshot to discover likely selectors when needed, then use agent_browser.click/fill/type/select/check/uncheck/press/scroll/scrollintoview to execute. Use read_page to read page text when asked to summarize or verify content. You can also draw into an on-page canvas using canvas_draw (default canvas is #ai-canvas). After each action, briefly confirm what you did and what changed. Avoid destructive actions unless the user confirms.";
    const languageCode = typeof globalConfig.languageCode === "string" ? globalConfig.languageCode : "en-US";
    const protocols = Array.isArray(globalConfig.protocols) ? globalConfig.protocols.filter(Boolean) : [];
    const debug = Boolean(globalConfig.debug);
    this.config = { autoGreet, greeting, voiceName, model, systemInstruction, languageCode, protocols, debug };
    return this.config;
  }

  static getWorkletUrl() {
    if (!VoiceGuide._workletUrl) {
      const workletCode = [
        "class PcmCaptureProcessor extends AudioWorkletProcessor {",
        "  process(inputs) {",
        "    const input = inputs[0];",
        "    if (input && input[0]) {",
        "      const channel = input[0];",
        "      const int16 = new Int16Array(channel.length);",
        "      for (let i = 0; i < channel.length; i++) {",
        "        const sample = Math.max(-1, Math.min(1, channel[i]));",
        "        int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;",
        "      }",
        "      this.port.postMessage(int16.buffer, [int16.buffer]);",
        "    }",
        "    return true;",
        "  }",
        "}",
        "registerProcessor('pcm-capture', PcmCaptureProcessor);"
      ].join("\\n");
      VoiceGuide._workletUrl = URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" }));
    }
    return VoiceGuide._workletUrl;
  }

  connectedCallback() {
    this.render();
  }

  render() {
    this.shadowRoot.innerHTML = \`
      <style>
        :host { --primary: #1a73e8; }
        .btn { position: fixed; bottom: 20px; right: 20px; width: 60px; height: 60px; 
               background: var(--primary); border-radius: 50%; cursor: pointer; 
               display: flex; align-items: center; justify-content: center; z-index: 9999;
               box-shadow: 0 4px 12px rgba(0,0,0,0.2); border: none; font-size: 24px; transition: 0.3s; }
        .btn.active { background: #ea4335; transform: scale(1.1); animation: pulse 2s infinite; }
        @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(234, 67, 53, 0.7); } 70% { box-shadow: 0 0 0 15px rgba(234, 67, 53, 0); } 100% { box-shadow: 0 0 0 0 rgba(234, 67, 53, 0); } }
      </style>
      <button class="btn" id="mic-btn">🎙️</button>
    \`;
    this.shadowRoot.querySelector('#mic-btn').onclick = () => this.toggle();
  }

  async toggle() {
    if (this.socket) return this.stop();

    const config = this.getConfig();
    if (!this.audioCtx || this.audioCtx.state === "closed") {
      this.audioCtx = new AudioContext({ sampleRate: 16000 });
      this.nextPlayTime = 0;
    }
    if (this.audioCtx.state === "suspended") {
      this.audioCtx.resume();
    }

    this._setupComplete = false;
    this._afterSetupQueue = [];
    this.socket = (config.protocols && config.protocols.length)
      ? new WebSocket("${wsUrl}", config.protocols)
      : new WebSocket("${wsUrl}");
    this.socket.binaryType = "arraybuffer";
    this.shadowRoot.querySelector('.btn').classList.add('active');

    this.socket.onopen = () => {
      const modelResource = config.model.startsWith("models/")
        ? config.model
        : ("models/" + config.model);

      // Live API WebSockets message format: https://ai.google.dev/api/live
      this.socket.send(JSON.stringify({
        setup: {
          model: modelResource,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: config.voiceName }
              },
              languageCode: config.languageCode
            }
          },
          systemInstruction: {
            role: "system",
            parts: [{ text: config.systemInstruction }]
          },
          tools: [{
            functionDeclarations: [
              {
                name: "read_page",
                description: "Reads key text from the current page so you can answer questions about it."
              },
              {
                name: "agent_browser",
                description: "Performs browser UI actions on the current page (click, type, fill, focus, hover, key presses, navigation, etc).",
                parameters: {
                  type: "object",
                  properties: {
                    action: {
                      type: "string",
                      enum: [
                        "open",
                        "click",
                        "dblclick",
                        "focus",
                        "type",
                        "fill",
                        "press",
                        "keydown",
                        "keyup",
                        "hover",
                        "select",
                        "check",
                        "uncheck",
                        "scroll",
                        "scrollintoview",
                        "drag",
                        "upload",
                        "screenshot",
                        "pdf",
                        "snapshot",
                        "eval",
                        "close"
                      ]
                    },
                    url: { type: "string", description: "URL to navigate to (for action=open)." },
                    selector: { type: "string", description: "CSS selector for the target element." },
                    text: { type: "string", description: "Text to type/fill (for action=type/fill)." },
                    key: { type: "string", description: "Key to press (for press/keydown/keyup), e.g. Enter, Tab, ArrowDown, Control+a." },
                    value: { type: "string", description: "Value to select (for action=select)." },
                    direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction (for action=scroll)." },
                    px: { type: "number", description: "Pixels to scroll (for action=scroll)." },
                    src: { type: "string", description: "Source selector (for action=drag)." },
                    tgt: { type: "string", description: "Target selector (for action=drag)." },
                    js: { type: "string", description: "JavaScript to evaluate (for action=eval)." },
                    timeoutMs: { type: "number", description: "Optional timeout to wait for selector (best-effort)." },
                    behavior: { type: "string", enum: ["smooth", "auto"], description: "Scroll behavior." }
                  },
                  required: ["action"]
                }
              },
              {
                name: "scroll",
                description: "Scrolls the page (or a scrollable container) up/down by a given amount, or to top/bottom.",
                parameters: {
                  type: "object",
                  properties: {
                    direction: { type: "string", enum: ["up", "down"], description: "Scroll direction." },
                    amount: { type: "number", description: "How far to scroll. Interpreted using unit." },
                    unit: { type: "string", enum: ["px", "viewport", "percent"], description: "Units for amount: pixels, fraction of viewport height, or percent of scroll range." },
                    to: { type: "string", enum: ["top", "bottom"], description: "Scroll directly to top/bottom (overrides direction/amount)." },
                    selector: { type: "string", description: "Optional CSS selector of a scrollable container to scroll instead of the page." },
                    behavior: { type: "string", enum: ["smooth", "auto"], description: "Scroll behavior." }
                  }
                }
              },
              {
                name: "scroll_to",
                description: "Scrolls the page to an element matching the provided CSS selector.",
                parameters: {
                  type: "object",
                  properties: {
                    selector: { type: "string", description: "A CSS selector for the target element." }
                  },
                  required: ["selector"]
                }
              },
              {
                name: "canvas_draw",
                description: "Draws shapes/text into a canvas element on the page (defaults to #ai-canvas).",
                parameters: {
                  type: "object",
                  properties: {
                    op: { type: "string", enum: ["clear", "set_style", "line", "rect", "circle", "text", "path"], description: "Drawing operation." },
                    selector: { type: "string", description: "CSS selector for the target canvas element (optional)." },
                    unit: { type: "string", enum: ["px", "percent"], description: "Coordinate unit: px or percent (0-100) of canvas size." },
                    mode: { type: "string", enum: ["stroke", "fill", "fill_stroke"], description: "How to render shapes." },
                    strokeStyle: { type: "string", description: "CSS color for strokes." },
                    fillStyle: { type: "string", description: "CSS color for fills." },
                    lineWidth: { type: "number", description: "Stroke width in px." },
                    font: { type: "string", description: "Canvas font string, e.g. 16px sans-serif." },
                    textAlign: { type: "string", enum: ["left", "center", "right"], description: "Text alignment." },
                    x1: { type: "number" },
                    y1: { type: "number" },
                    x2: { type: "number" },
                    y2: { type: "number" },
                    x: { type: "number" },
                    y: { type: "number" },
                    w: { type: "number" },
                    h: { type: "number" },
                    r: { type: "number" },
                    text: { type: "string" },
                    points: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { x: { type: "number" }, y: { type: "number" } },
                        required: ["x", "y"]
                      }
                    },
                    closePath: { type: "boolean" },
                    background: { type: "string", description: "For clear: background fill color." }
                  },
                  required: ["op"]
                }
              }
            ]
          }]
        }
      }));

      // Spec requires waiting for setupComplete before sending other messages.
      this._enqueueAfterSetup(async () => {
        if (config.autoGreet && !this.hasGreeted) {
          this.hasGreeted = true;
          this.sendText(config.greeting);
        }
        await this.startAudio();
      });
    };

    this.socket.onmessage = async (e) => {
      let msg;
      try {
        if (typeof e.data === "string") {
          msg = JSON.parse(e.data);
        } else {
          const text = new TextDecoder().decode(e.data);
          msg = JSON.parse(text);
        }
      } catch (err) {
        if (this.getConfig().debug) {
          console.warn("VoiceGuide message parse failed:", err);
        }
        return;
      }
      const config = this.getConfig();

      if (msg.setupComplete) {
        this._setupComplete = true;
        this._drainAfterSetupQueue();
        return;
      }

      const serverContent = msg.serverContent;
      if (serverContent?.interrupted && this.audioCtx) {
        // Reset the playback queue on interruption.
        this.nextPlayTime = Math.max(this.audioCtx.currentTime, 0);
      }
      const modelTurn = serverContent?.modelTurn;
      const parts = modelTurn?.parts || [];
      if (config.debug && !parts.length) {
        console.log("VoiceGuide raw message:", msg);
      }
      for (const part of parts) {
        const inlineData = part?.inlineData;
        if (inlineData?.data) {
          this.lastAudioAt = Date.now();
          this.playAudio(inlineData.data, inlineData.mimeType || inlineData.mime_type);
          if (config.debug) {
            console.log("VoiceGuide audio:", inlineData.mimeType || inlineData.mime_type);
          }
        } else if (config.debug && part?.text) {
          console.log("VoiceGuide text:", part.text);
        }
      }
      if (msg.toolCall) await this.handleTools(msg.toolCall);
    };

    this.socket.onerror = (event) => {
      if (this.getConfig().debug) {
        console.warn("VoiceGuide socket error:", event);
      }
    };

    this.socket.onclose = (event) => {
      if (this.getConfig().debug) {
        console.warn("VoiceGuide socket closed:", event.code, event.reason);
      }
    };
  }

  async handleTools(toolCall) {
    const calls = toolCall.functionCalls || [];
    if (!calls.length) return;

    const parseArgs = (call) => {
      if (!call) return {};
      if (typeof call.args === "string") {
        try { return JSON.parse(call.args); } catch { return {}; }
      }
      return call.args || {};
    };

    const waitFor = async (selector, timeoutMs) => {
      const ms = (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) ? timeoutMs : 0;
      if (!selector || typeof selector !== "string") return null;
      const start = Date.now();
      while (true) {
        const el = document.querySelector(selector);
        if (el) return el;
        if (!ms || Date.now() - start >= ms) return null;
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    const isEditable = (el) => {
      if (!el) return false;
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return true;
      return Boolean(el.isContentEditable);
    };

    const setEditableValue = (el, value) => {
      if (!el) return;
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") {
        el.value = value;
      } else if (el.isContentEditable) {
        el.textContent = value;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const dispatchMouse = (el, type, extra = {}) => {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const clientX = rect.left + Math.min(rect.width / 2, 10);
      const clientY = rect.top + Math.min(rect.height / 2, 10);
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX,
        clientY,
        ...extra
      }));
    };

    const keySpec = (keyString) => {
      const raw = typeof keyString === "string" ? keyString : "";
      const parts = raw.split("+").map((p) => p.trim()).filter(Boolean);
      const lower = parts.map((p) => p.toLowerCase());
      const isCtrl = lower.includes("control") || lower.includes("ctrl");
      const isMeta = lower.includes("meta") || lower.includes("cmd") || lower.includes("command");
      const isAlt = lower.includes("alt") || lower.includes("option");
      const isShift = lower.includes("shift");
      const key = parts.length ? parts[parts.length - 1] : "";
      return { key, ctrlKey: isCtrl, metaKey: isMeta, altKey: isAlt, shiftKey: isShift };
    };

    const dispatchKey = (type, keyString) => {
      const el = document.activeElement || document.body;
      const spec = keySpec(keyString);
      el.dispatchEvent(new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        key: spec.key,
        ...spec
      }));
    };

    const doScrollGeneric = (direction, px, behavior) => {
      const dir = direction === "up" || direction === "down" || direction === "left" || direction === "right" ? direction : "down";
      const amt = (typeof px === "number" && Number.isFinite(px)) ? px : 300;
      const sign = (dir === "up" || dir === "left") ? -1 : 1;
      const dx = (dir === "left" || dir === "right") ? sign * amt : 0;
      const dy = (dir === "up" || dir === "down") ? sign * amt : 0;
      window.scrollBy({ left: dx, top: dy, behavior });
    };

    const doSnapshot = () => {
      const candidates = Array.from(document.querySelectorAll(
        "a,button,input,select,textarea,[role='button'],[role='link'],[onclick],[tabindex]"
      ));
      const unique = [];
      const seen = new Set();
      for (const el of candidates) {
        if (!(el instanceof Element)) continue;
        if (el.getClientRects().length === 0) continue;
        const key = el.tagName + "|" + (el.id || "") + "|" + (el.className || "") + "|" + (el.getAttribute("name") || "");
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(el);
        if (unique.length >= 60) break;
      }
      const items = unique.map((el, idx) => {
        const tag = (el.tagName || "").toLowerCase();
        const role = el.getAttribute("role") || undefined;
        const label = (el.getAttribute("aria-label") || "").trim();
        const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
        const name = label || text || (el.getAttribute("name") || "") || (el.id ? ("#" + el.id) : "");
        let selector = "";
        if (el.id) selector = "#" + CSS.escape(el.id);
        else if (el.getAttribute("name")) selector = tag + "[name='" + el.getAttribute("name").replace(/'/g, "\\'") + "']";
        else if (el.classList && el.classList.length) selector = tag + "." + Array.from(el.classList).slice(0, 2).map((c) => CSS.escape(c)).join(".");
        else selector = tag;
        return { ref: "ref:" + (idx + 1), tag, role, name, selector };
      });
      return { items };
    };

    const functionResponses = [];
    for (const call of calls) {
      const args = parseArgs(call);
      let response = {};

      try {
        if (call.name === "read_page") {
          response = { text: document.body.innerText.slice(0, 2000) };
        } else if (call.name === "scroll") {
          // Existing rich scroll tool
          const behavior = args.behavior === "auto" ? "auto" : "smooth";
          const selector = typeof args.selector === "string" ? args.selector : "";
          const targetEl = selector ? document.querySelector(selector) : null;
          const scrollRoot = document.scrollingElement || document.documentElement;
          const scrollTarget = targetEl || scrollRoot;

          if (!scrollTarget) {
            response = { status: "not_found", selector };
          } else {
            const to = typeof args.to === "string" ? args.to : "";
            const isPage = scrollTarget === scrollRoot || scrollTarget === document.body || scrollTarget === document.documentElement;
            const scrollTo = (top) => {
              if (isPage) window.scrollTo({ top, behavior });
              else scrollTarget.scrollTo({ top, behavior });
            };
            if (to === "top") {
              scrollTo(0);
              response = { status: "scrolled", to: "top", selector: selector || undefined };
            } else if (to === "bottom") {
              const maxTop = Math.max(0, scrollTarget.scrollHeight - scrollTarget.clientHeight);
              scrollTo(maxTop);
              response = { status: "scrolled", to: "bottom", selector: selector || undefined };
            } else {
              const direction = args.direction === "up" ? "up" : "down";
              const unit = args.unit === "px" || args.unit === "percent" || args.unit === "viewport" ? args.unit : "viewport";
              const rawAmount = (typeof args.amount === "number" && Number.isFinite(args.amount)) ? args.amount : 0.85;
              const sign = direction === "up" ? -1 : 1;
              let deltaY;
              if (unit === "px") {
                deltaY = sign * rawAmount;
              } else if (unit === "percent") {
                const scrollRange = Math.max(0, scrollTarget.scrollHeight - scrollTarget.clientHeight);
                deltaY = sign * (rawAmount / 100) * scrollRange;
              } else {
                deltaY = sign * rawAmount * window.innerHeight;
              }
              if (isPage) window.scrollBy({ top: deltaY, behavior });
              else scrollTarget.scrollBy({ top: deltaY, behavior });
              response = { status: "scrolled", direction, amount: rawAmount, unit, selector: selector || undefined };
            }
          }
        } else if (call.name === "scroll_to") {
          const selector = args.selector;
          if (typeof selector === "string" && selector.length) {
            document.querySelector(selector)?.scrollIntoView({ behavior: "smooth" });
          }
          response = { status: "scrolled" };
        } else if (call.name === "canvas_draw") {
          const op = typeof args.op === "string" ? args.op : "";
          const selector = typeof args.selector === "string" && args.selector.length ? args.selector : "#ai-canvas";
          const unit = args.unit === "percent" ? "percent" : "px";
          const mode = (args.mode === "fill" || args.mode === "fill_stroke") ? args.mode : "stroke";

          const canvas = document.querySelector(selector);
          if (!(canvas instanceof HTMLCanvasElement)) {
            response = { status: "not_found", selector };
          } else {
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              response = { status: "error", error: "Canvas 2D context not available", selector };
            } else {
              const toPxX = (v) => {
                const n = (typeof v === "number" && Number.isFinite(v)) ? v : 0;
                return unit === "percent" ? (n / 100) * canvas.width : n;
              };
              const toPxY = (v) => {
                const n = (typeof v === "number" && Number.isFinite(v)) ? v : 0;
                return unit === "percent" ? (n / 100) * canvas.height : n;
              };

              // Apply style (optional)
              if (typeof args.strokeStyle === "string") ctx.strokeStyle = args.strokeStyle;
              if (typeof args.fillStyle === "string") ctx.fillStyle = args.fillStyle;
              if (typeof args.lineWidth === "number" && Number.isFinite(args.lineWidth) && args.lineWidth > 0) ctx.lineWidth = args.lineWidth;
              if (typeof args.font === "string" && args.font.trim()) ctx.font = args.font;
              if (args.textAlign === "left" || args.textAlign === "center" || args.textAlign === "right") ctx.textAlign = args.textAlign;

              const renderShape = () => {
                if (mode === "fill") {
                  ctx.fill();
                } else if (mode === "fill_stroke") {
                  ctx.fill();
                  ctx.stroke();
                } else {
                  ctx.stroke();
                }
              };

              if (op === "clear") {
                const bg = typeof args.background === "string" ? args.background : "#ffffff";
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = bg;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.restore();
                response = { status: "ok", op, selector, background: bg };
              } else if (op === "set_style") {
                response = {
                  status: "ok",
                  op,
                  selector,
                  strokeStyle: ctx.strokeStyle,
                  fillStyle: ctx.fillStyle,
                  lineWidth: ctx.lineWidth,
                  font: ctx.font,
                  textAlign: ctx.textAlign
                };
              } else if (op === "line") {
                const x1 = toPxX(args.x1);
                const y1 = toPxY(args.y1);
                const x2 = toPxX(args.x2);
                const y2 = toPxY(args.y2);
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
                response = { status: "ok", op, selector };
              } else if (op === "rect") {
                const x = toPxX(args.x);
                const y = toPxY(args.y);
                const w = unit === "percent" ? (toPxX(args.w) - toPxX(0)) : (typeof args.w === "number" ? args.w : 0);
                const h = unit === "percent" ? (toPxY(args.h) - toPxY(0)) : (typeof args.h === "number" ? args.h : 0);
                if (mode === "fill") ctx.fillRect(x, y, w, h);
                else if (mode === "fill_stroke") {
                  ctx.fillRect(x, y, w, h);
                  ctx.strokeRect(x, y, w, h);
                } else ctx.strokeRect(x, y, w, h);
                response = { status: "ok", op, selector };
              } else if (op === "circle") {
                const x = toPxX(args.x);
                const y = toPxY(args.y);
                const r = unit === "percent" ? (toPxX(args.r) - toPxX(0)) : (typeof args.r === "number" ? args.r : 0);
                ctx.beginPath();
                ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
                renderShape();
                response = { status: "ok", op, selector };
              } else if (op === "text") {
                const x = toPxX(args.x);
                const y = toPxY(args.y);
                const t = typeof args.text === "string" ? args.text.slice(0, 200) : "";
                if (mode === "stroke") ctx.strokeText(t, x, y);
                else if (mode === "fill_stroke") {
                  ctx.fillText(t, x, y);
                  ctx.strokeText(t, x, y);
                } else ctx.fillText(t, x, y);
                response = { status: "ok", op, selector, textLength: t.length };
              } else if (op === "path") {
                const pts = Array.isArray(args.points) ? args.points : [];
                const closePath = Boolean(args.closePath);
                if (!pts.length) {
                  response = { status: "error", error: "Missing points", selector };
                } else {
                  ctx.beginPath();
                  ctx.moveTo(toPxX(pts[0].x), toPxY(pts[0].y));
                  for (let i = 1; i < pts.length; i++) {
                    ctx.lineTo(toPxX(pts[i].x), toPxY(pts[i].y));
                  }
                  if (closePath) ctx.closePath();
                  renderShape();
                  response = { status: "ok", op, selector, points: pts.length, closePath };
                }
              } else {
                response = { status: "error", error: "Unknown op", op, selector };
              }
            }
          }
        } else if (call.name === "agent_browser") {
          const action = typeof args.action === "string" ? args.action : "";
          const behavior = args.behavior === "auto" ? "auto" : "smooth";
          const timeoutMs = args.timeoutMs;

          if (action === "open") {
            if (typeof args.url === "string" && args.url) {
              window.location.href = args.url;
              response = { status: "navigating", url: args.url };
            } else {
              response = { status: "error", error: "Missing url" };
            }
          } else if (action === "click" || action === "dblclick" || action === "focus" || action === "hover" || action === "scrollintoview") {
            const selector = typeof args.selector === "string" ? args.selector : "";
            const el = selector ? (await waitFor(selector, timeoutMs)) : null;
            if (!el) {
              response = { status: "not_found", selector };
            } else {
              if (action === "scrollintoview") {
                el.scrollIntoView({ behavior, block: "center", inline: "center" });
                response = { status: "scrolled", selector };
              } else if (action === "focus") {
                el.focus();
                response = { status: "focused", selector };
              } else if (action === "hover") {
                dispatchMouse(el, "mousemove");
                dispatchMouse(el, "mouseover");
                dispatchMouse(el, "mouseenter");
                response = { status: "hovered", selector };
              } else if (action === "dblclick") {
                dispatchMouse(el, "mousedown");
                dispatchMouse(el, "mouseup");
                dispatchMouse(el, "click");
                dispatchMouse(el, "mousedown");
                dispatchMouse(el, "mouseup");
                dispatchMouse(el, "click");
                dispatchMouse(el, "dblclick");
                if (typeof el.click === "function") el.click();
                response = { status: "clicked", click: "double", selector };
              } else {
                dispatchMouse(el, "mousedown");
                dispatchMouse(el, "mouseup");
                dispatchMouse(el, "click");
                if (typeof el.click === "function") el.click();
                response = { status: "clicked", selector };
              }
            }
          } else if (action === "type" || action === "fill") {
            const selector = typeof args.selector === "string" ? args.selector : "";
            const text = typeof args.text === "string" ? args.text : "";
            const el = selector ? (await waitFor(selector, timeoutMs)) : (document.activeElement || null);
            if (!el) {
              response = { status: "not_found", selector };
            } else if (!isEditable(el)) {
              response = { status: "error", error: "Target not editable", selector };
            } else {
              el.focus();
              if (action === "fill") {
                setEditableValue(el, text);
              } else {
                // type: append to existing
                const tag = (el.tagName || "").toLowerCase();
                if (tag === "input" || tag === "textarea") {
                  setEditableValue(el, (el.value || "") + text);
                } else if (el.isContentEditable) {
                  setEditableValue(el, (el.textContent || "") + text);
                }
              }
              response = { status: action === "fill" ? "filled" : "typed", selector: selector || undefined, length: text.length };
            }
          } else if (action === "press" || action === "keydown" || action === "keyup") {
            const key = typeof args.key === "string" ? args.key : "";
            if (!key) {
              response = { status: "error", error: "Missing key" };
            } else {
              if (action === "press") {
                dispatchKey("keydown", key);
                dispatchKey("keyup", key);

                // best-effort: submit on Enter
                const spec = keySpec(key);
                if (spec.key.toLowerCase() === "enter") {
                  const el = document.activeElement;
                  const form = el && el.form;
                  if (form && typeof form.requestSubmit === "function") {
                    try { form.requestSubmit(); } catch { /* ignore */ }
                  }
                }
              } else {
                dispatchKey(action, key);
              }
              response = { status: "ok", action, key };
            }
          } else if (action === "select") {
            const selector = typeof args.selector === "string" ? args.selector : "";
            const value = typeof args.value === "string" ? args.value : "";
            const el = selector ? (await waitFor(selector, timeoutMs)) : null;
            if (!el) {
              response = { status: "not_found", selector };
            } else if ((el.tagName || "").toLowerCase() !== "select") {
              response = { status: "error", error: "Target is not a <select>", selector };
            } else {
              el.value = value;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              response = { status: "selected", selector, value };
            }
          } else if (action === "check" || action === "uncheck") {
            const selector = typeof args.selector === "string" ? args.selector : "";
            const el = selector ? (await waitFor(selector, timeoutMs)) : null;
            if (!el) {
              response = { status: "not_found", selector };
            } else if ((el.tagName || "").toLowerCase() !== "input" || (el.getAttribute("type") || "").toLowerCase() !== "checkbox") {
              response = { status: "error", error: "Target is not a checkbox", selector };
            } else {
              el.checked = action === "check";
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              response = { status: action === "check" ? "checked" : "unchecked", selector };
            }
          } else if (action === "scroll") {
            doScrollGeneric(args.direction, args.px, behavior);
            response = { status: "scrolled", direction: args.direction || "down", px: args.px || 300 };
          } else if (action === "drag") {
            const srcSel = typeof args.src === "string" ? args.src : "";
            const tgtSel = typeof args.tgt === "string" ? args.tgt : "";
            const srcEl = srcSel ? (await waitFor(srcSel, timeoutMs)) : null;
            const tgtEl = tgtSel ? (await waitFor(tgtSel, timeoutMs)) : null;
            if (!srcEl || !tgtEl) {
              response = { status: "not_found", src: srcSel || undefined, tgt: tgtSel || undefined };
            } else {
              // Best-effort drag via mouse events.
              dispatchMouse(srcEl, "mousedown");
              dispatchMouse(srcEl, "mousemove");
              dispatchMouse(tgtEl, "mousemove");
              dispatchMouse(tgtEl, "mouseup");
              response = { status: "ok", action: "drag", src: srcSel, tgt: tgtSel };
            }
          } else if (action === "snapshot") {
            response = doSnapshot();
          } else if (action === "eval") {
            const config = this.getConfig();
            if (!config.debug) {
              response = { status: "denied", reason: "Enable debug to allow eval" };
            } else if (typeof args.js !== "string" || !args.js.trim()) {
              response = { status: "error", error: "Missing js" };
            } else {
              // Best-effort eval; returns JSON-safe result.
              let result;
              try { result = (0, eval)(args.js); } catch (e) { result = { error: String(e?.message || e) }; }
              try {
                response = { status: "ok", result: JSON.parse(JSON.stringify(result)) };
              } catch {
                response = { status: "ok", result: String(result) };
              }
            }
          } else if (action === "upload" || action === "screenshot" || action === "pdf") {
            response = { status: "not_supported", action, reason: "Browser security restrictions in an embedded widget" };
          } else if (action === "close") {
            window.close();
            response = { status: "ok", action: "close" };
          } else {
            response = { status: "error", error: "Unknown action", action };
          }
        } else {
          response = { status: "error", error: "Unknown tool", name: call.name };
        }
      } catch (e) {
        response = { status: "error", error: String(e?.message || e) };
      }

      functionResponses.push({ id: call.id, name: call.name, response });
    }

    const payload = JSON.stringify({
      toolResponse: { functionResponses }
    });

    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(payload);
    } else if (this.getConfig().debug) {
      console.log("VoiceGuide toolResponse (no socket):", payload);
    }

    return functionResponses;
  }

  _enqueueAfterSetup(fn) {
    if (this._setupComplete) {
      Promise.resolve().then(fn);
      return;
    }
    this._afterSetupQueue.push(fn);
  }

  _drainAfterSetupQueue() {
    const queue = this._afterSetupQueue.slice();
    this._afterSetupQueue = [];
    for (const fn of queue) {
      Promise.resolve().then(fn);
    }
  }

  sendText(text) {
    if (!text || !this.socket || this.socket.readyState !== 1) return;
    this.socket.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true
      }
    }));
  }

  async startAudio() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.micStream = stream;
    if (!this.audioCtx || this.audioCtx.state === "closed") {
      this.audioCtx = new AudioContext({ sampleRate: 16000 });
      this.nextPlayTime = 0;
    }
    if (this.audioCtx.state === "suspended") {
      await this.audioCtx.resume();
    }
    const source = this.audioCtx.createMediaStreamSource(stream);

    if (this.audioCtx.audioWorklet?.addModule) {
      try {
        await this.audioCtx.audioWorklet.addModule(VoiceGuide.getWorkletUrl());
        this.workletNode = new AudioWorkletNode(this.audioCtx, "pcm-capture");
        this.workletNode.port.onmessage = (event) => {
          if (this.socket?.readyState === 1) {
            const base64 = btoa(String.fromCharCode(...new Uint8Array(event.data)));
            this.socket.send(JSON.stringify({
              realtimeInput: {
                audio: { data: base64, mimeType: "audio/pcm;rate=16000" }
              }
            }));
          }
        };
        source.connect(this.workletNode);
        this.workletNode.connect(this.audioCtx.destination);
        return;
      } catch (err) {
        console.warn("AudioWorklet init failed, falling back to ScriptProcessor.", err);
      }
    }

    const processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(this.audioCtx.destination);
    processor.onaudioprocess = (e) => {
      if (this.socket?.readyState === 1) {
        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) int16[i] = float32[i] * 0x7FFF;
        const base64 = btoa(String.fromCharCode(...new Uint8Array(int16.buffer)));
        this.socket.send(JSON.stringify({
          realtimeInput: {
            audio: { data: base64, mimeType: "audio/pcm;rate=16000" }
          }
        }));
      }
    };
  }

  playAudio(base64, mimeType) {
    const rateMatch = mimeType?.match(/rate=(\d+)/);
    const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
    const binary = atob(base64);
    const view = new DataView(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) {
        view.setUint8(i, binary.charCodeAt(i));
    }
    
    // Default to Gemini's 24kHz PCM when the rate isn't provided.
    const pcmData = new Int16Array(view.buffer);
    const float32Data = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
        float32Data[i] = pcmData[i] / 32768.0;
    }

    if (!this.audioCtx || this.audioCtx.state === "closed") {
      this.audioCtx = new AudioContext({ sampleRate });
      this.nextPlayTime = 0;
    }
    if (this.audioCtx.state === "suspended") {
      this.audioCtx.resume();
    }
    
    const buffer = this.audioCtx.createBuffer(1, float32Data.length, sampleRate);
    buffer.getChannelData(0).set(float32Data);
    
    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioCtx.destination);
    
    // Queue playback
    if (this.nextPlayTime < this.audioCtx.currentTime) {
        this.nextPlayTime = this.audioCtx.currentTime;
    }
    source.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;
  }

  stop() {
    this.socket?.close();
    this.socket = null;
    this._setupComplete = false;
    this._afterSetupQueue = [];
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.audioCtx?.close();
    this.audioCtx = null;
    this.nextPlayTime = 0;
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }
    this.shadowRoot.querySelector('.btn').classList.remove('active');
  }
}
customElements.define('voice-guide', VoiceGuide);
const __vgEl = document.createElement('voice-guide');
document.body.appendChild(__vgEl);

try {
  const __cfg = (typeof window !== "undefined" && window.VOICE_GUIDE_CONFIG) ? window.VOICE_GUIDE_CONFIG : {};
  if (__cfg && __cfg.debug) {
    const makeId = () => {
      try {
        return (crypto && typeof crypto.randomUUID === "function") ? crypto.randomUUID() : String(Date.now());
      } catch {
        return String(Date.now());
      }
    };
    window.VOICE_GUIDE_TEST = {
      callTool: async (name, args) => {
        return await __vgEl.handleTools({
          functionCalls: [{ id: makeId(), name, args: args || {} }]
        });
      },
      agentBrowser: async (args) => {
        return await __vgEl.handleTools({
          functionCalls: [{ id: makeId(), name: "agent_browser", args: args || {} }]
        });
      },
      scroll: async (args) => {
        return await __vgEl.handleTools({
          functionCalls: [{ id: makeId(), name: "scroll", args: args || {} }]
        });
      },
      scrollTo: async (selector) => {
        return await __vgEl.handleTools({
          functionCalls: [{ id: makeId(), name: "scroll_to", args: { selector } }]
        });
      },
      readPage: async () => {
        return await __vgEl.handleTools({
          functionCalls: [{ id: makeId(), name: "read_page", args: {} }]
        });
      }
    };
    console.log("VOICE_GUIDE_TEST is available for manual tool testing.");
  }
} catch {
  // ignore
}
  `;
}
