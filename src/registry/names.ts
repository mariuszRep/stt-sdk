// The display names of catalog models. Two entries can carry the same name (two Cohere Transcribe builds, one general and
// one tuned for Arabic), and a list of them reads as a repeated row: `withUniqueNames` gives each a name of its own. Pure.

const tokensOf = (id: string) => id.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
const capitalized = (token: string) => token.charAt(0).toUpperCase() + token.slice(1);

/** `name (what sets the model apart)`: the words of the id the other models with this name do not have. */
function nameWith(name: string, tokens: readonly string[]): string {
  return tokens.length ? `${name} (${tokens.map(capitalized).join(" ")})` : name;
}

const allDistinct = (names: readonly string[]) => new Set(names).size === names.length;

/**
 * The models with every display name unique. A name shared by several models is told apart by the words of the model ids
 * that the others do not have ("cohere-transcribe-arabic-07-2026" next to "cohere-transcribe-03-2026" becomes "Cohere
 * Transcribe (Arabic)"); the one with no word of its own keeps the plain name. Version numbers are used only when words
 * are not enough. Models whose names are already unique come back as they are.
 */
export function withUniqueNames<T extends { id: string; name: string }>(models: readonly T[]): T[] {
  const byName = new Map<string, T[]>();
  for (const model of models) byName.set(model.name, [...(byName.get(model.name) ?? []), model]);

  const renamed = new Map<string, string>();
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const tokens = group.map((model) => tokensOf(model.id));
    const own = tokens.map((mine) => mine.filter((token) => !tokens.every((other) => other.includes(token))));
    const words = own.map((mine) => mine.filter((token) => /[a-z]/.test(token)));
    const names = (distinguishing: string[][]) => group.map((_, i) => nameWith(name, distinguishing[i] ?? []));
    const chosen = [words, own].map(names).find(allDistinct) ?? names(own);
    group.forEach((model, i) => renamed.set(model.id, chosen[i] ?? name));
  }
  return models.map((model) => (renamed.has(model.id) ? { ...model, name: renamed.get(model.id)! } : model));
}
