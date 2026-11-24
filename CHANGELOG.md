# Changelog

## 0.4.0

Since 0.3.9.

Added
- `OpenAIProvider` and `GroqProvider` transcribe for real: batch transcription over the OpenAI audio API
  (`POST /audio/transcriptions`) on your own key, with language, prompt, temperature and, when asked, word timings.
  `listModels()` lists the SDK's known speech models of the provider. No live stream (`createStream` throws
  `UnsupportedCapabilityError`). Their endpoints, names and retryable refusals are the registry's provider data, and the
  answer is read as stt-server's is (words in their segments). A call without a signal of its own gives up after the
  provider's time in the registry (60 s); an upload without a filename is named by its audio type. They were typed
  seams that threw on every call.
- `SttServerManagement.setDefaultModelWhenIdle` verifies a model the server says needs verification
  (`needs_verification`) once, reporting progress through `onVerifying`, then selects it.
  `SttServerManagement.verifyModelAndWait`, `isNeedsVerificationError` and the `PollOptions` type are new.
- `wordBoost` capability and `boostWords` / `boostWeight` on a batch request, for stt-server's Parakeet models.
- Registry: OpenRouter's speech-out (`tts`) service and five models with their voices, audio format and pcm rate.

Breaking (0.x: the minor version is the breaking one)
- `ManagedModel.cloud` is gone: whether a model runs in the cloud is its `locality` label (`"cloud"`), as on every
  registry entry. No server ever set `cloud`; read `locality === "cloud"` instead.
- `OpenAIProvider` / `GroqProvider`: `baseUrl` now includes the version path (`https://api.openai.com/v1`,
  `https://api.groq.com/openai/v1`), as the registry's provider data has it, and the stubs' public `options` property is
  gone. Both only threw before, so no working call changes.

Fixed
- `setDefaultModelWhenIdle` waits for a busy server for its full time after a verification, however long that took.

Deprecated (unchanged since 0.3.8, removed in 1.0)
- `LocalRuntimeProvider`, `FasterWhisperProvider`, `WhisperCppProvider`, `createProvider` and
  `RuntimeConnectionDescriptor`: use `SttServerProvider` (and `SttServerManagement`).
