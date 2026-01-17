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

        const closeIfOpen = (socket, code, reason) => {
          if (!socket) return;
          if (socket.readyState === 0 || socket.readyState === 1) {
            socket.close(code, reason);
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
      : "You are a helpful, concise voice assistant for this website. Answer questions about the current page and help the user navigate.";
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
                name: "scroll_to",
                description: "Scrolls the page to an element matching the provided CSS selector.",
                parameters: {
                  type: "object",
                  properties: {
                    selector: { type: "string", description: "A CSS selector for the target element." }
                  },
                  required: ["selector"]
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
      if (msg.toolCall) this.handleTools(msg.toolCall);
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
    const call = toolCall.functionCalls?.[0];
    if (!call) return;
    let response = "";
    if (call.name === "read_page") {
      response = { text: document.body.innerText.slice(0, 2000) };
    } else if (call.name === "scroll_to") {
      const args = typeof call.args === "string" ? (() => { try { return JSON.parse(call.args); } catch { return {}; } })() : (call.args || {});
      const selector = args.selector;
      if (typeof selector === "string" && selector.length) {
        document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth' });
      }
      response = { status: "scrolled" };
    }
    this.socket.send(JSON.stringify({
      toolResponse: {
        functionResponses: [{ id: call.id, name: call.name, response }]
      }
    }));
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
document.body.appendChild(document.createElement('voice-guide'));
  `;
}
