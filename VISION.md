# VISION.md — STT SDK

## Purpose

`stt-sdk` is the Voice Typer provider-communication library. It gives applications one normalized interface for provider-specific local runtime endpoints and cloud STT APIs.

## Responsibilities

- Provider discovery, capabilities, models, batch transcription, streaming, transcript events, timestamps, and structured errors.
- Provider adapters such as `FasterWhisperProvider` and `WhisperCppProvider` for their respective local runtime endpoints.
- Cloud adapters such as `OpenAIProvider`, `DeepgramProvider`, and `GroqProvider`.

## Boundaries

The SDK connects to endpoints. It does not detect hardware, install providers/models, start/stop processes, manage provider updates, or supervise local runtimes. Those are `stt-server` responsibilities. The server may consume the SDK as a released library for shared communication and contract code; the SDK never depends on the server.

## Success Criteria

- An application can use a cloud provider without `stt-server`.
- An application can connect to a server-provided local runtime descriptor without provider-specific app code.
- Local and cloud providers expose one normalized SDK contract.
