# CONVENTIONS.md — STT SDK

- Use a provider-facing interface for `info`, `models`, `transcribe`, and optional `stream`.
- Normalize capabilities, models, transcript events, timestamps, and errors across adapters.
- Implement named local provider adapters such as `FasterWhisperProvider` and `WhisperCppProvider`; each adapter maps its endpoint and capabilities to the common SDK contract.
- Implement cloud providers as named API translators; never require `stt-server` for cloud operation.
- Do not add hardware detection, installation, model download, runtime lifecycle, or process supervision.
- Version the SDK independently and preserve compatibility within a major version.
