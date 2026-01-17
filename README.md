# ai-voice-guide

Embeddable voice assistant widget that makes any website audio-driven.

Visitors can click the floating mic button, ask questions about the current page/site, and hear spoken answers. The assistant can also navigate the page (for example, scroll to a relevant section).

This project uses **Google Gemini Live API (WebSockets)** and is aligned with the current Live API docs:
- https://ai.google.dev/gemini-api/docs/live?example=mic-stream
- https://ai.google.dev/api/live

## Architecture

- Cloudflare Worker serves the widget script at `/guide.js`.
- The widget opens a WebSocket to the Worker at `/ws`.
- The Worker proxies the socket to the Live API v1beta endpoint:
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`
- Browser streams mic audio as **16-bit PCM, 16kHz, mono**.
- Gemini responds with audio (commonly **24kHz PCM**) which the widget plays.

## Embed on any website

Add this snippet before the closing `</body>` tag (or anywhere after you define the config):

```html
<script>
  window.VOICE_GUIDE_CONFIG = {
    // Default model from Google's official Live API mic-stream example
    model: "gemini-2.5-flash-native-audio-preview-12-2025",

    voiceName: "Kore",
    languageCode: "en-US",

    autoGreet: true,
    greeting: "Hi! Ask me anything about this website.",

    systemInstruction: "You are a helpful, concise voice assistant for this website. Answer questions about the current page and help the user navigate.",

    // Optional: WebSocket subprotocols (usually not needed with Live API v1beta)
    // protocols: [],

    debug: false
  };
</script>

<script src="https://YOUR_WORKER_DOMAIN/guide.js"></script>
```

## Tool use (navigation)

The widget exposes basic tools so Gemini can act on the page:
- `read_page`: read key text from the current document.
- `scroll`: scroll up/down (or to top/bottom), optionally within a container.
- `scroll_to`: scroll to an element by CSS selector.

It also exposes a more general browser-action tool:
- `agent_browser`: perform common UI actions on the client (click, fill/type, focus, hover, key presses, select, check/uncheck, scroll, scroll-into-view, simple drag, navigate, snapshot).

Notes / limitations:
- `upload`, `screenshot`, `pdf`: intentionally return `not_supported` (browser security restrictions in an embedded widget).
- `eval`: denied unless `VOICE_GUIDE_CONFIG.debug = true`.

You can extend this approach to support richer navigation (open menus, click buttons, route to URLs, search site content, etc.).

## Memory across page loads (localStorage)

Goal: persist a lightweight session state in `localStorage` so the assistant can continue context after navigation/reload.

Current status:
- Not fully implemented yet (the widget is ready to be extended to add this).

Suggested approach:
- Store `{ sessionId, lastUrl, lastIntent, updatedAt }`.
- Restore on load and optionally greet with a short recap.

## Security notes

- Do not ship your Gemini API key to the browser.
- Configure `GEMINI_API_KEY` as a Worker secret.
- Update the Worker's WebSocket `Origin` allow-list for your real domains.
- For production client-direct setups, Google recommends ephemeral tokens; this project uses a server-to-server proxy (Worker) so the API key stays server-side.

## Local development

```bash
bun i
wrangler dev
```

Open [test_client.html](test_client.html) to load the widget from `http://localhost:8787/guide.js`.

## Testing UI actions (click/type/etc)

Set `VOICE_GUIDE_CONFIG.debug = true` and use DevTools on the page.

The widget exposes a debug-only helper:
- `window.VOICE_GUIDE_TEST`

Examples (paste in the browser console):
- `await VOICE_GUIDE_TEST.agentBrowser({ action: "snapshot" })`
- `await VOICE_GUIDE_TEST.agentBrowser({ action: "click", selector: "h1" })`
- `await VOICE_GUIDE_TEST.agentBrowser({ action: "scroll", direction: "down", px: 600 })`
- `await VOICE_GUIDE_TEST.readPage()`

If the mic is not connected, tool responses will be logged as:
`VoiceGuide toolResponse (no socket): ...`

### Voice-driven test phrases

With the mic on, try saying:
- "Scroll to the deep section and click the Deep Click button"
- "Fill the Name field with Mircea and select Pro"
- "Check Agree to terms and submit the form"
- "Read the page and tell me what the form status says"

## Deploy

```bash
wrangler secret put GEMINI_API_KEY
wrangler deploy
```

## Source

- Worker + widget: [src/index.js](src/index.js)
- Test page: [test_client.html](test_client.html)
