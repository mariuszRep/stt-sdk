import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { FasterWhisperProvider } from "../src/providers/faster-whisper";
import type { TranscriptEvent, SessionState } from "../src/types";
import configFixture from "./fixtures/faster-whisper-config.json";

/**
 * End-to-end contract test: runs a real in-process HTTP + WebSocket server that
 * mimics the current Voice Typer runtime (batch endpoint, /v1/config, and the
 * protocol-v1 /v1/audio/stream lifecycle) and exercises the provider over real
 * sockets — including binary PCM transport and unknown-field tolerance.
 */

function parseMultipart(body: Buffer, contentType: string): Map<string, { filename?: string; content: Buffer }> {
  const match = /boundary=(.+)$/.exec(contentType);
  if (!match) return new Map();
  const boundary = match[1]!.replace(/^"|"$/g, "");
  const parts = body.toString("latin1").split(`--${boundary}`);
  const result = new Map<string, { filename?: string; content: Buffer }>();
  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    if (!name) continue;
    let content = Buffer.from(part.slice(headerEnd + 4), "latin1");
    if (content.length >= 2 && content.subarray(content.length - 2).toString() === "\r\n") {
      content = content.subarray(0, content.length - 2);
    }
    result.set(name, { filename: /filename="([^"]+)"/.exec(headers)?.[1], content });
  }
  return result;
}

describe("FasterWhisperProvider — e2e against an in-process runtime", () => {
  let server: Server;
  let wss: WebSocketServer;
  let port: number;
  let receivedBinary: Buffer[] = [];
  let receivedStart: Record<string, unknown> | null = null;
  let receivedMultipart: Map<string, { filename?: string; content: Buffer }> | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? "";

      if (url === "/v1/config") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(configFixture));
        return;
      }

      if (url === "/v1/audio/transcriptions") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", () => {
          const body = Buffer.concat(chunks);
          const contentType = req.headers["content-type"] ?? "";
          receivedMultipart = parseMultipart(body, contentType);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ text: "e2e transcription result" }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    wss = new WebSocketServer({ server, path: "/v1/audio/stream" });
    wss.on("connection", (socket: WsSocket) => {
      let partialSent = false;
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          receivedBinary.push(data as Buffer);
          // Emit the partial only after audio arrives, mirroring a real runtime
          // and avoiding a race with the consumer attaching handlers after
          // `createStream` resolves.
          if (!partialSent) {
            partialSent = true;
            socket.send(
              JSON.stringify({
                type: "partial",
                id: "seg-1",
                text: "e2e par",
                startMs: 0,
                endMs: 900,
                extraUnknownField: true,
              }),
            );
          }
          return;
        }
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === "start") {
          receivedStart = msg;
          socket.send(
            JSON.stringify({
              type: "ready",
              sessionId: "e2e-session",
              provider: "faster-whisper",
              protocolVersion: 1,
              model: "e2e-model",
              language: msg.language ?? "auto",
              sampleRate: 16000,
              channels: 1,
              extraUnknownField: "tolerated",
            }),
          );
        } else if (msg.type === "stop") {
          socket.send(JSON.stringify({ type: "final", id: "seg-1", text: "e2e partial final", startMs: 0, endMs: 1200 }));
          socket.send(JSON.stringify({ type: "closed", reason: "client_stop" }));
          socket.close();
        } else if (msg.type === "abort") {
          socket.send(JSON.stringify({ type: "closed", reason: "client_abort" }));
          socket.close();
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("runs the full streaming lifecycle over real WebSocket with binary PCM transport", async () => {
    const provider = new FasterWhisperProvider({ baseUrl: `http://127.0.0.1:${port}` });
    const events: TranscriptEvent[] = [];
    const states: SessionState[] = [];

    const session = await provider.createStream({
      language: "en",
      model: "auto",
      encoding: "pcm_s16le",
      sampleRate: 48000,
      channels: 1,
      prompt: "e2e context",
    });
    session.onEvent = (e) => events.push(e);
    session.onStateChange = (s) => states.push(s);

    expect(receivedStart).toMatchObject({
      type: "start",
      protocolVersion: 1,
      language: "en",
      model: "auto",
      encoding: "pcm_s16le",
      sampleRate: 48000,
      channels: 1,
      prompt: "e2e context",
    });
    expect(session.state).toBe("active");
    // onStateChange is attached after `createStream` resolves, so the earlier
    // "starting"/"active" transitions are not observable through the callback;
    // the "stopping"/"closed" transitions are asserted after stop below.

    // Binary PCM over the wire; the server emits a partial with an unknown field.
    session.sendAudio(new Uint8Array(3200));
    await new Promise((r) => setTimeout(r, 100));
    expect(receivedBinary.length).toBeGreaterThan(0);
    expect(receivedBinary[0]!.byteLength).toBe(3200);

    // Partial arrived after audio; the server-side unknown field must be tolerated.
    expect(events[0]).toMatchObject({ type: "partial", id: "seg-1", text: "e2e par" });
    expect((events[0] as { extraUnknownField?: unknown }).extraUnknownField).toBe(true);

    // Graceful stop: server flushes final + closed and closes.
    await session.stop();
    await new Promise((r) => setTimeout(r, 100));

    expect(events.some((e) => e.type === "final" && e.text === "e2e partial final")).toBe(true);
    expect(events.some((e) => e.type === "closed" && e.reason === "client_stop")).toBe(true);
    expect(session.state).toBe("closed");
    expect(states).toContain("stopping");
    expect(states).toContain("closed");
  });

  it("runs the batch contract over real HTTP including multipart file + prompt", async () => {
    const provider = new FasterWhisperProvider({ baseUrl: `http://127.0.0.1:${port}` });

    const result = await provider.transcribe({
      file: new Uint8Array([10, 20, 30, 40]),
      filename: "recording.webm",
      prompt: "batch context",
    });

    expect(result).toEqual({ text: "e2e transcription result" });
    expect(receivedMultipart?.get("file")?.filename).toBe("recording.webm");
    expect(receivedMultipart?.get("file")?.content.subarray(0, 4)).toEqual(
      Buffer.from([10, 20, 30, 40]),
    );
    expect(receivedMultipart?.get("prompt")?.content.toString()).toBe("batch context");
  });

  it("listModels reads the runtime config over real HTTP", async () => {
    const provider = new FasterWhisperProvider({ baseUrl: `http://127.0.0.1:${port}` });
    const models = await provider.listModels();
    expect(models[0]?.id).toBe("Systran/faster-whisper-small");
  });
});
