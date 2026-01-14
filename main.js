export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. ROUTE: Serve the Web Component Script
    if (url.pathname === "/guide.js") {
      return new Response(generateWidgetScript(url.origin), {
        headers: { "Content-Type": "application/javascript" },
      });
    }

    // 2. ROUTE: Secure WebSocket Proxy
    if (request.headers.get("Upgrade") === "websocket") {
      // Security: Replace with your actual domain(s)
      const origin = request.headers.get("Origin");
      if (origin && !origin.includes("localhost") && !origin.includes("yourdomain.com")) {
        return new Response("Unauthorized", { status: 403 });
      }

      const googleUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${env.GEMINI_API_KEY}`;
      
      return fetch(googleUrl, { headers: request.headers });
    }

    return new Response("Voice Guide Worker is Active", { status: 200 });
  },
};

// This function contains the entire Web Component code
function generateWidgetScript(workerBaseUrl) {
  // Convert https to wss for the websocket connection
  const wsUrl = workerBaseUrl.replace("https://", "wss://") + "/ws";

  return `
class VoiceGuide extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.audioCtx = null;
    this.socket = null;
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
    
    this.socket = new WebSocket("${wsUrl}");
    this.shadowRoot.querySelector('.btn').classList.add('active');

    this.socket.onopen = () => {
      this.socket.send(JSON.stringify({
        setup: {
          model: "models/gemini-2.0-flash-exp",
          tools: [{
            function_declarations: [
              { name: "read_page", description: "Reads the content of the current page." },
              { name: "scroll_to", description: "Scrolls to a section", parameters: { type: "object", properties: { selector: { type: "string" } } } }
            ]
          }]
        }
      }));
      this.startAudio();
    };

    this.socket.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
        this.playAudio(msg.serverContent.modelTurn.parts[0].inlineData.data);
      }
      if (msg.toolCall) this.handleTools(msg.toolCall);
    };
  }

  async handleTools(toolCall) {
    const call = toolCall.functionCalls[0];
    let response = "";
    if (call.name === "read_page") {
      response = { text: document.body.innerText.slice(0, 2000) };
    } else if (call.name === "scroll_to") {
      document.querySelector(call.args.selector)?.scrollIntoView({ behavior: 'smooth' });
      response = { status: "scrolled" };
    }
    this.socket.send(JSON.stringify({
      tool_response: { function_responses: [{ name: call.name, response }] }
    }));
  }

  async startAudio() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.audioCtx = new AudioContext({ sampleRate: 16000 });
    const source = this.audioCtx.createMediaStreamSource(stream);
    const processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(this.audioCtx.destination);

    processor.onaudioprocess = (e) => {
      if (this.socket?.readyState === 1) {
        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) int16[i] = float32[i] * 0x7FFF;
        const base64 = btoa(String.fromCharCode(...new Uint8Array(int16.buffer)));
        this.socket.send(JSON.stringify({ realtime_input: { media_chunks: [{ data: base64, mime_type: "audio/pcm" }] } }));
      }
    };
  }

  playAudio(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    // Note: In production, use a buffer queue for 24kHz output
    const blob = new Blob([bytes], { type: 'audio/pcm' });
    console.log("Playing response chunk...");
  }

  stop() {
    this.socket?.close();
    this.socket = null;
    this.audioCtx?.close();
    this.shadowRoot.querySelector('.btn').classList.remove('active');
  }
}
customElements.define('voice-guide', VoiceGuide);
document.body.appendChild(document.createElement('voice-guide'));
  `;
}
