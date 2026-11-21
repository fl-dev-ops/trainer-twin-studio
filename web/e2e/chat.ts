import { createServer } from "node:http";
import { localVoice } from "./env";

// Only admit the session; no model, transcription, or voice worker runs in this test.
if (localVoice) createServer((request, response) => {
  request.resume();
  if (request.method !== "POST" || request.url !== "/internal/sessions") return response.writeHead(404).end();
  if (request.headers.authorization !== "Bearer e2e-only-chat-secret") return response.writeHead(401).end();
  response.writeHead(204).end();
}).listen(3996, "127.0.0.1");
