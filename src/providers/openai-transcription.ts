/**
 * The transcription response of the OpenAI audio API (`json` / `verbose_json`), as stt-server, OpenAI and Groq send it,
 * mapped to a {@link TranscriptionResult}: one reader for every provider that speaks it.
 */

import type { TranscriptionResult, TranscriptionSegment, TranscriptWord } from "../types";

interface ServerTranscriptionWord {
  word: string;
  start: number;
  end: number;
  probability?: number;
}

interface ServerTranscriptionSegment {
  text: string;
  start: number;
  end: number;
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
  words?: ServerTranscriptionWord[];
}

export interface ServerTranscriptionResponse {
  text: string;
  language?: string;
  duration?: number;
  segments?: ServerTranscriptionSegment[];
  /** stt-server's `verbose_json` with word granularity: one list for the whole file, not per segment. */
  words?: ServerTranscriptionWord[];
  x_diagnostics?: Record<string, unknown>;
}

function mapWord(word: ServerTranscriptionWord): TranscriptWord {
  return {
    word: word.word,
    startMs: Math.round(word.start * 1000),
    endMs: Math.round(word.end * 1000),
    probability: word.probability ?? 0,
  };
}

function mapSegment(segment: ServerTranscriptionSegment): TranscriptionSegment {
  return {
    text: segment.text,
    startMs: Math.round(segment.start * 1000),
    endMs: Math.round(segment.end * 1000),
    avgLogprob: segment.avg_logprob,
    noSpeechProb: segment.no_speech_prob,
    compressionRatio: segment.compression_ratio,
    words: segment.words?.map(mapWord),
  };
}

/**
 * Puts the file-wide `words` list into the segments: each word goes to the segment that contains its midpoint (the
 * nearest one when it falls in a gap), after the words the segment already carries. Words without any segment to
 * go into get one segment of their own that spans them and holds the whole text.
 */
function placeWords(text: string, segments: TranscriptionSegment[], words: TranscriptWord[]): TranscriptionSegment[] {
  if (segments.length === 0) {
    return [{ text, startMs: words[0]!.startMs, endMs: words[words.length - 1]!.endMs, words }];
  }
  const placed = segments.map((segment) => ({ ...segment, words: [...(segment.words ?? [])] }));
  for (const word of words) {
    const mid = (word.startMs + word.endMs) / 2;
    const distance = (segment: TranscriptionSegment) => Math.max(segment.startMs - mid, mid - segment.endMs, 0);
    const home = placed.reduce((best, segment) => (distance(segment) < distance(best) ? segment : best));
    home.words.push(word);
  }
  return placed;
}

export function mapTranscriptionResponse(body: ServerTranscriptionResponse): TranscriptionResult {
  const result: TranscriptionResult = { text: body.text };
  if (body.language !== undefined) result.language = body.language;
  if (body.duration !== undefined) result.durationMs = Math.round(body.duration * 1000);
  const segments = body.segments?.map(mapSegment);
  // Segments that already carry words (a server that nests them) keep them; the file-wide list is only used otherwise.
  const nested = segments?.some((segment) => segment.words?.length) ?? false;
  const words = body.words && !nested ? body.words.map(mapWord) : [];
  if (words.length > 0) result.segments = placeWords(body.text, segments ?? [], words);
  else if (segments !== undefined) result.segments = segments;
  if (body.x_diagnostics !== undefined) result.diagnostics = body.x_diagnostics;
  return result;
}
