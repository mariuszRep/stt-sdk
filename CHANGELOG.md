# Changelog

## 0.4.0

Since 0.3.9.

Added
- `OpenAIProvider` and `GroqProvider` transcribe for real: batch transcription over the OpenAI audio API
  (`POST /audio/transcriptions`) on your own key, with language, prompt, temperature and, when asked, word timings.
  `listModels()` lists the SDK's known speech models of the provider. No live stream (`createStream` throws
  `UnsupportedCapabilityError`). Their endpoints, names and retryable refusals are the registry's provider data, and the
  answer is read as stt-server's is (words in their segments). They were typed seams that threw on every call.
- `SttServerManagement.setDefaultModelWhenIdle` verifies a model the server says needs verification
  (`needs_verification`) once, reporting progress through `onVerifying`, then selects it.
  `SttServerManagement.verifyModelAndWait`, `isNeedsVerificationError` and the `PollOptions` type are new.
- `wordBoost` capability and `boostWords` / `boostWeight` on a batch request, for stt-server's Parakeet models.
- Registry: OpenRouter's speech-out (`tts`) service and five models with their voices, audio format and pcm rate.

Changed
- `ManagedModel.cloud` is gone: whether a model runs in the cloud is its `locality` label (`"cloud"`), as on every
  registry entry. No server ever set `cloud`.

Deprecated (unchanged since 0.3.8, removed in 1.0)
- `LocalRuntimeProvider`, `FasterWhisperProvider`, `WhisperCppProvider`, `createProvider` and
  `RuntimeConnectionDescriptor`: use `SttServerProvider` (and `SttServerManagement`).
