import { OpenAIAudioProvider, type OpenAIAudioOptions } from "./openai-audio";

export type GroqProviderOptions = OpenAIAudioOptions;

/** Groq's transcription API (Whisper Large v3 and its Turbo), OpenAI's shape: batch transcription of a whole recording, on your own key. */
export class GroqProvider extends OpenAIAudioProvider {
  constructor(options: GroqProviderOptions) {
    super("groq", "whisper-large-v3-turbo", options);
  }
}
