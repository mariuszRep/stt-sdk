import { OpenAIAudioProvider, type OpenAIAudioOptions } from "./openai-audio";

export type OpenAIProviderOptions = OpenAIAudioOptions;

/** OpenAI's transcription API (`gpt-transcribe`, `whisper-1`): batch transcription of a whole recording, on your own key. */
export class OpenAIProvider extends OpenAIAudioProvider {
  constructor(options: OpenAIProviderOptions) {
    super("openai", "gpt-transcribe", options);
  }
}
