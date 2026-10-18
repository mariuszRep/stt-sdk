/**
 * Pure helpers over speaker embeddings (`SttServerProvider.embedSpeakers`): similarity, matching against saved
 * profiles and clustering. They only work on vectors of one model; they never call the server.
 */

/** Cosine similarity of two vectors, -1 to 1 (1 = the same direction). A zero vector is similar to nothing: 0. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) {
    throw new RangeError(`Embeddings differ in length (${a.length} and ${b.length}); they come from different models.`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const [x, y] = [a[i]!, b[i]!];
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/** A saved voice: whatever identifies it to the caller, plus its embedding. */
export interface SpeakerProfile {
  embedding: ArrayLike<number>;
}

export interface SpeakerMatch<P extends SpeakerProfile> {
  profile: P;
  similarity: number;
}

/**
 * The saved profile `embedding` sounds most like, or null when none reaches `threshold` (a cosine similarity;
 * about 0.4 separates the same voice from another with the CAM++ VoxCeleb model). Ties go to the earlier profile.
 */
export function matchSpeaker<P extends SpeakerProfile>(
  embedding: ArrayLike<number>,
  profiles: readonly P[],
  threshold: number,
): SpeakerMatch<P> | null {
  let best: SpeakerMatch<P> | null = null;
  for (const profile of profiles) {
    const similarity = cosineSimilarity(embedding, profile.embedding);
    if (similarity >= threshold && (best === null || similarity > best.similarity)) best = { profile, similarity };
  }
  return best;
}

export interface ClusterOptions {
  /** Two clusters merge while their average similarity is at least this. Default 0.4. */
  threshold?: number;
  /** Merging goes on past `threshold` until at most this many clusters remain. Default: no limit. */
  maxSpeakers?: number;
}

/**
 * Groups embeddings by voice with average-linkage agglomerative clustering: every embedding starts alone, and the two
 * clusters with the highest mean pairwise cosine similarity merge while that mean is at least `threshold` or more than
 * `maxSpeakers` clusters remain. Returns one label per input, numbered from 0 in order of first appearance; a null
 * embedding (a segment too short to fingerprint) gets -1. stt-server's `/v1/audio/diarize` runs a Rust port of this
 * algorithm; both are tested against the same cases (`test/fixtures/cluster-golden.json`), so change them together.
 */
export function clusterSpeakers(
  embeddings: ReadonlyArray<ArrayLike<number> | null>,
  options: ClusterOptions = {},
): number[] {
  const { threshold = 0.4, maxSpeakers = Infinity } = options;
  const members = new Map<number, number[]>();
  embeddings.forEach((embedding, index) => {
    if (embedding) members.set(index, [index]);
  });
  // similarity.get(a).get(b): mean pairwise similarity of clusters a and b, which a merge updates in place.
  const similarity = new Map<number, Map<number, number>>();
  for (const a of members.keys()) {
    similarity.set(a, new Map());
    for (const b of members.keys()) {
      if (a < b) similarity.get(a)!.set(b, cosineSimilarity(embeddings[a]!, embeddings[b]!));
    }
  }

  while (members.size > 1) {
    let best: { a: number; b: number; value: number } | null = null;
    for (const [a, row] of similarity) {
      for (const [b, value] of row) {
        if (best === null || value > best.value) best = { a, b, value };
      }
    }
    if (best === null || (best.value < threshold && members.size <= maxSpeakers)) break;
    const { a, b } = best;
    const [sizeA, sizeB] = [members.get(a)!.length, members.get(b)!.length];
    for (const c of members.keys()) {
      if (c === a || c === b) continue;
      const withA = c < a ? similarity.get(c)!.get(a)! : similarity.get(a)!.get(c)!;
      const withB = c < b ? similarity.get(c)!.get(b)! : similarity.get(b)!.get(c)!;
      const merged = (sizeA * withA + sizeB * withB) / (sizeA + sizeB);
      if (c < a) similarity.get(c)!.set(a, merged);
      else similarity.get(a)!.set(c, merged);
    }
    // Cluster b is absorbed into a (a < b, so the labels stay in order of first appearance).
    members.get(a)!.push(...members.get(b)!);
    members.delete(b);
    similarity.delete(b);
    for (const row of similarity.values()) row.delete(b);
  }

  const labels = new Array<number>(embeddings.length).fill(-1);
  [...members.keys()]
    .sort((x, y) => x - y)
    .forEach((id, label) => {
      for (const index of members.get(id)!) labels[index] = label;
    });
  return labels;
}
