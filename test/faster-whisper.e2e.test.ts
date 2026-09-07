import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FasterWhisperProvider } from "../src/providers/faster-whisper";
import configFixture from "./fixtures/faster-whisper-config.json";

/**
 * End-to-end contract test: runs a real in-process HTTP server that mimics
 * the current Voice Typer runtime (batch endpoint + /v1/config) and exercises
 * the provider over a real socket, including multipart file + prompt.
 *
 * This used to also cover the protocol-v1 /v1/audio/stream WebSocket
 * lifecycle, removed along with the local WS streaming engine — see
 * `providers/faster-whisper.ts`'s class doc comment.
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
  let port: number;
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

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
