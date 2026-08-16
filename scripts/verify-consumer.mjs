/**
 * Package-consumer verification: pack the SDK tarball, install it into a blank
 * consumer fixture (no sibling repositories, no workspace links), typecheck both
 * ESM and CJS consumers against the published entry points, and audit the
 * tarball contents for private/undesired files.
 *
 * Run after `npm run build` (or rely on the prepack hook): `npm run verify:consumer`.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  return execSync(cmd, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });
}

// 1. Pack. The `prepack` hook (tsup build) writes banner lines to stdout before
// the `--json` array, so parse from the first `[`.
const packJson = run("npm pack --json");
const [{ filename }] = JSON.parse(packJson.slice(packJson.indexOf("[")));
const tarball = join(root, filename);
console.log(`Packed ${filename}`);

// 2. Audit tarball contents.
const entries = run(`tar -tzf "${tarball}"`).trim().split("\n");
console.log(`Tarball entries: ${entries.length}`);
const forbidden = entries.filter(
  (e) =>
    e.includes("/src/") ||
    e.includes(".projectflows") ||
    e.includes(".env") ||
    e.includes("credentials") ||
    e.includes("node_modules") ||
    /\/test\//.test(e) ||
    /\/scripts\//.test(e),
);
if (forbidden.length > 0) {
  console.error("Forbidden entries found in tarball:");
  for (const f of forbidden) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("Tarball audit OK (no src/, test/, scripts/, .projectflows, env, or credential files)");

// 3. Blank consumer fixture in a temp dir (no siblings present).
const fixture = mkdtempSync(join(tmpdir(), "stt-sdk-consumer-"));
try {
  mkdirSync(join(fixture, "src"), { recursive: true });
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify(
      {
        name: "stt-sdk-consumer-fixture",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: { "@open-vibe-ai/stt-sdk": `file:${tarball}` },
        devDependencies: { typescript: "^5.7.3", "@types/node": "^22.10.0" },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(fixture, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          esModuleInterop: true,
        },
        include: ["src"],
      },
      null,
      2,
    ),
  );

  // ESM consumer (import condition).
  writeFileSync(
    join(fixture, "src", "index.ts"),
    `
import {
  FasterWhisperProvider,
  DeepgramProvider,
  WhisperCppProvider,
  OpenAIProvider,
  GroqProvider,
  createProvider,
  PROTOCOL_VERSION,
  RUNTIME_DESCRIPTOR_SCHEMA_VERSION,
  SttError,
} from "@open-vibe-ai/stt-sdk";
import type {
  SttProvider,
  RuntimeConnectionDescriptor,
  StreamConfig,
  TranscriptEvent,
  BatchTranscriptionRequest,
  TranscriptionResult,
  SessionState,
  StreamSession,
} from "@open-vibe-ai/stt-sdk";

const local: SttProvider = new FasterWhisperProvider({ baseUrl: "http://127.0.0.1:8000" });
const cloud: SttProvider = new DeepgramProvider({ apiKey: "test" });
const seam: SttProvider = new WhisperCppProvider({ baseUrl: "http://127.0.0.1:8001" });
const _o: SttProvider = new OpenAIProvider({ apiKey: "test" });
const _g: SttProvider = new GroqProvider({ apiKey: "test" });

const descriptor: RuntimeConnectionDescriptor = {
  schemaVersion: 1,
  provider: "faster-whisper",
  protocol: "voice-typer-v1",
  transport: "http",
  baseUrl: "http://127.0.0.1:8000",
  streaming: {
    enabled: true,
    endpoint: "/v1/audio/stream",
    protocolVersion: 1,
    encodings: ["pcm_s16le"],
    sampleRates: [16000, 44100, 48000],
    resample: true,
    channels: [1],
  },
};
const fromDescriptor: SttProvider = createProvider(descriptor);

const config: StreamConfig = {
  language: "en",
  model: "auto",
  encoding: "pcm_s16le",
  sampleRate: 48000,
  channels: 1,
};
const request: BatchTranscriptionRequest = { file: new Uint8Array([1, 2, 3]), prompt: "ctx" };
const onEvent = (event: TranscriptEvent): void => {
  if (event.type === "final") console.log(event.text);
};
const onState = (state: SessionState): void => console.log(state);
const session: StreamSession = {
  state: "idle",
  onEvent,
  onStateChange: onState,
  sendAudio: () => {},
  stop: async () => {},
  abort: () => {},
};

async function main(): Promise<void> {
  const result: TranscriptionResult = await local.transcribe(request);
  console.log(result.text, cloud.capability.id, seam.capability.id, fromDescriptor.id);
  console.log(PROTOCOL_VERSION, RUNTIME_DESCRIPTOR_SCHEMA_VERSION, SttError.name, config.encoding, session.state);
}
void main();
`,
  );

  // CJS consumer (require condition).
  writeFileSync(
    join(fixture, "src", "require-check.cts"),
    `
const sdk = require("@open-vibe-ai/stt-sdk");
const provider = new sdk.FasterWhisperProvider({ baseUrl: "http://127.0.0.1:8000" });
const dg = new sdk.DeepgramProvider({ apiKey: "test" });
const fromDescriptor = sdk.createProvider({
  schemaVersion: 1,
  provider: "faster-whisper",
  protocol: "voice-typer-v1",
  transport: "http",
  baseUrl: "http://127.0.0.1:8000",
});
console.log(provider.capability.id, dg.capability.id, fromDescriptor.id, sdk.PROTOCOL_VERSION);
`,
  );

  console.log("Installing tarball into blank consumer fixture…");
  run("npm install --no-audit --no-fund --loglevel=error", { cwd: fixture });
  console.log("Typechecking consumer (ESM + CJS) against the installed package…");
  run("npx tsc --noEmit", { cwd: fixture });

  const installed = existsSync(join(fixture, "node_modules", "@voice-typer", "stt-sdk", "dist", "index.js"));
  if (!installed) {
    console.error("Installed package missing dist/index.js");
    process.exit(1);
  }
  console.log("Consumer verification OK: installed from tarball, ESM + CJS typecheck passed");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
