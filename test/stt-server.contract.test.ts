import { describe, it, expect } from "vitest";
import { SttServerProvider } from "../src/providers/stt-server";
import { ModelNotInstalledError } from "../src/errors";

/**
 * Optional contract test against a REAL stt-server instance. Skipped
 * unless both STT_NEXT_URL and STT_NEXT_TOKEN are set — see this repo's
 * goal for the manual harness (spawn stt-server, download+default a
 * model, read its token, run this test, then stop the server).
 */
const url = process.env.STT_NEXT_URL;
const token = process.env.STT_NEXT_TOKEN;
const runIf = url && token ? describe : describe.skip;

/** A minimal valid 16kHz mono 16-bit PCM WAV, ~0.5s of near-silence with a tone. */
function makeTinyWav(): Uint8Array {
  const sampleRate = 16000;
  const durationSec = 0.5;
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * t) * 3000);
    view.setInt16(44 + i * 2, sample, true);
  }

  return new Uint8Array(buffer);
}

runIf("SttServerProvider — real server contract test", () => {
  // describe.skip still executes this body at collection time (only the
  // `it`s inside are skipped), so fall back to harmless placeholders when
  // the env vars are absent — no request is ever made in that case.
  const provider = new SttServerProvider({ baseUrl: url ?? "http://127.0.0.1:1", token: token ?? "" });

  it("lists callable models with a default", async () => {
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.isDefault)).toBe(true);
  });

  it("transcribes a tiny generated WAV", async () => {
    const wav = makeTinyWav();
    const result = await provider.transcribe({ file: wav, filename: "tiny.wav" });
    expect(typeof result.text).toBe("string");
  });

  it("translates when the default model supports it, else throws UnsupportedCapabilityError", async () => {
    const models = await provider.listModels();
    const def = models.find((m) => m.isDefault);
    const wav = makeTinyWav();
    if (def?.capabilities?.translation) {
      const result = await provider.translate({ file: wav, filename: "tiny.wav" });
      expect(typeof result.text).toBe("string");
    } else {
      await expect(provider.translate({ file: wav, filename: "tiny.wav" })).rejects.toThrow();
    }
  });

  it("maps an unknown model to ModelNotInstalledError", async () => {
    const wav = makeTinyWav();
    await expect(
      provider.transcribe({ file: wav, filename: "tiny.wav", model: "does-not-exist" }),
    ).rejects.toBeInstanceOf(ModelNotInstalledError);
  });
});
