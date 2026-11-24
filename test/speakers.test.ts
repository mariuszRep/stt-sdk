import { describe, it, expect } from "vitest";
import { clusterSpeakers, cosineSimilarity, matchSpeaker } from "../src/speakers";
import fixture from "./fixtures/two-speaker-embeddings.json";
import golden from "./fixtures/cluster-golden.json";

describe("cosineSimilarity", () => {
  it("is 1 for the same direction, 0 for orthogonal and -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [0, 5])).toBe(0);
    expect(cosineSimilarity([1, -1], [-1, 1])).toBeCloseTo(-1, 12);
  });

  it("takes typed arrays and treats a zero vector as similar to nothing", () => {
    expect(cosineSimilarity(new Float32Array([3, 4]), new Float32Array([3, 4]))).toBeCloseTo(1, 6);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("rejects vectors of different lengths", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(RangeError);
  });
});

describe("matchSpeaker", () => {
  const profiles = [
    { name: "Ann", embedding: [1, 0, 0] },
    { name: "Bob", embedding: [0, 1, 0] },
    { name: "Cy", embedding: [0.9, 0.1, 0] },
  ];

  it("returns the most similar profile with its similarity", () => {
    const match = matchSpeaker([0.1, 1, 0], profiles, 0.5)!;
    expect(match.profile.name).toBe("Bob");
    expect(match.similarity).toBeGreaterThan(0.99);
  });

  it("returns null when no profile reaches the threshold or there are none", () => {
    expect(matchSpeaker([0, 0, 1], profiles, 0.2)).toBeNull();
    expect(matchSpeaker([1, 0, 0], [], 0)).toBeNull();
  });

  it("prefers the earlier profile on a tie", () => {
    const twins = [
      { id: 1, embedding: [1, 0] },
      { id: 2, embedding: [1, 0] },
    ];
    expect(matchSpeaker([1, 0], twins, 0.9)!.profile.id).toBe(1);
  });
});

describe("clusterSpeakers", () => {
  const a = [1, 0, 0];
  const b = [0, 1, 0];
  const c = [0, 0, 1];
  const nearA = [0.95, 0.05, 0];

  it("groups similar embeddings and numbers the clusters in order of first appearance", () => {
    expect(clusterSpeakers([b, a, nearA, b], { threshold: 0.5 })).toEqual([0, 1, 1, 0]);
  });

  it("makes every embedding its own cluster when none is similar enough, and one cluster for a threshold of -1", () => {
    expect(clusterSpeakers([a, b, c], { threshold: 0.5 })).toEqual([0, 1, 2]);
    expect(clusterSpeakers([a, b, c], { threshold: -1 })).toEqual([0, 0, 0]);
  });

  it("keeps merging past the threshold until maxSpeakers clusters remain", () => {
    const labels = clusterSpeakers([a, b, c, nearA], { threshold: 0.9, maxSpeakers: 2 });
    expect(new Set(labels).size).toBe(2);
    expect(labels[0]).toBe(labels[3]);
  });

  it("links by the average similarity of all member pairs", () => {
    // y and z are the closest pair and merge first. x is then compared with {y, z} by the mean of its
    // similarities to y (low) and to z (higher): single linkage would use the higher, complete the lower.
    const x = [1, 0];
    const y = [Math.cos(1.2), Math.sin(1.2)];
    const z = [Math.cos(0.9), Math.sin(0.9)];
    const toY = cosineSimilarity(x, y);
    const toZ = cosineSimilarity(x, z);
    const average = (toY + toZ) / 2;
    expect(clusterSpeakers([x, y, z], { threshold: (average + toZ) / 2 })).toEqual([0, 1, 1]);
    expect(clusterSpeakers([x, y, z], { threshold: (toY + average) / 2 })).toEqual([0, 0, 0]);
  });

  it("gives a null embedding (a segment too short to fingerprint) the label -1 and ignores it", () => {
    expect(clusterSpeakers([a, null, nearA, b], { threshold: 0.5 })).toEqual([0, -1, 0, 1]);
    expect(clusterSpeakers([])).toEqual([]);
    expect(clusterSpeakers([null])).toEqual([-1]);
  });

  it("recovers the speakers of the real two-voice recording (stt-server embeddings of its A/B/A/B turns)", () => {
    expect(fixture.model).toBe("campplus-voxceleb-v1");
    const script = fixture.labels.map((speaker) => (speaker === fixture.labels[0] ? 0 : 1));
    expect(clusterSpeakers(fixture.embeddings)).toEqual(script);
    expect(clusterSpeakers(fixture.embeddings, { maxSpeakers: 1 })).toEqual([0, 0, 0, 0]);
    const profiles = [
      { speaker: "A", embedding: fixture.embeddings[0]! },
      { speaker: "B", embedding: fixture.embeddings[1]! },
    ];
    expect(matchSpeaker(fixture.embeddings[2]!, profiles, 0.4)!.profile.speaker).toBe("A");
    expect(matchSpeaker(fixture.embeddings[3]!, profiles, 0.4)!.profile.speaker).toBe("B");
  });
});

describe("clusterSpeakers against the stt-server implementation", () => {
  // stt-server's /v1/audio/diarize clusters with a Rust port of this algorithm. Both must give these labels
  // (the same file is stt-server's tests/fixtures/cluster-golden.json); change them together.
  it.each(golden.cases.map((c) => [JSON.stringify(c), c] as const))("gives the shared labels for %s", (_, c) => {
    const options = { threshold: c.threshold, maxSpeakers: c.max_speakers ?? Infinity };
    expect(clusterSpeakers(golden.embeddings, options)).toEqual(c.labels);
  });
});
