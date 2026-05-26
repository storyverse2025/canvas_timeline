/**
 * Substring-search synonym dictionary.
 *
 * The canvas-api search layer matches a node's prompt by case-insensitive
 * substring. Users (and PM-agent intent) often ask in Chinese ("找出所
 * 有左轮手枪的图"), while prompts in the canvas are often a mix of
 * Chinese + English ("a worn revolver in his hand, soft window light").
 * Without expansion, the literal search "左轮手枪" misses every prompt
 * the AI wrote in English — even though they refer to the same object.
 *
 * Each entry below is a synonym group. searchNodes expands every query
 * term to the union of its group(s), then matches any of them as a
 * substring. New groups can be added freely; ordering is irrelevant.
 *
 * Keep terms short and unambiguous. Avoid generic single-letter words
 * ("枪" alone is ambiguous between gun/spear/rifle — already in the
 * 武器 group below, so still useful in context). Avoid words that would
 * create false positives across unrelated semantic fields.
 */

export interface SynonymGroup {
  /** Human label for telemetry / debug — not used in matching. */
  label: string;
  /** All terms that should match if any one is queried. Stored
   *  lowercased so the matcher can compare without re-allocating. */
  terms: string[];
}

const RAW_GROUPS: SynonymGroup[] = [
  {
    label: 'handgun',
    terms: ['左轮', '左轮手枪', '手枪', '枪', '配枪', 'revolver', 'pistol', 'handgun', 'sidearm', 'gun'],
  },
  {
    label: 'rifle',
    terms: ['步枪', '冲锋枪', '突击步枪', 'rifle', 'assault rifle', 'carbine', 'submachine gun'],
  },
  {
    label: 'mecha',
    terms: ['机甲', '机器人', '动力装甲', 'mech', 'mecha', 'exosuit', 'power armor', 'gundam'],
  },
  {
    label: 'sword',
    terms: ['剑', '刀', '武士刀', '长剑', 'sword', 'katana', 'blade', 'sabre'],
  },
  {
    label: 'horse',
    terms: ['马', '骏马', '战马', 'horse', 'steed', 'stallion'],
  },
  {
    label: 'fire',
    terms: ['火', '火焰', '烈火', '燃烧', 'fire', 'flame', 'blaze', 'burning'],
  },
  {
    label: 'rain',
    terms: ['雨', '下雨', '暴雨', 'rain', 'rainfall', 'downpour'],
  },
  {
    label: 'night',
    terms: ['夜', '夜晚', '夜景', 'night', 'nighttime', 'midnight'],
  },
];

// Build a case-folded lookup once at module load: term → all terms in
// every group that contains it. A term can live in multiple groups
// (rare, but the math just unions them).
const TERM_TO_EXPANSION: Map<string, string[]> = (() => {
  const m = new Map<string, Set<string>>();
  for (const g of RAW_GROUPS) {
    const lowered = g.terms.map((t) => t.toLowerCase());
    for (const t of lowered) {
      const existing = m.get(t) ?? new Set<string>();
      lowered.forEach((other) => existing.add(other));
      m.set(t, existing);
    }
  }
  const out = new Map<string, string[]>();
  for (const [k, v] of m) out.set(k, Array.from(v));
  return out;
})();

/**
 * Expand one query term to its synonym set (including the original).
 * Returns deduped lowercase terms. If the input matches no group, the
 * single-element array `[term.toLowerCase()]` is returned so the caller
 * can always just iterate the result.
 */
export function expandTerm(term: string): string[] {
  const k = term.toLowerCase().trim();
  if (!k) return [];
  return TERM_TO_EXPANSION.get(k) ?? [k];
}

/**
 * Expand many terms in one call, dedupe across the union. Used by
 * searchNodes when the caller supplies promptContains:[...].
 */
export function expandTerms(terms: string[]): string[] {
  const out = new Set<string>();
  for (const t of terms) for (const e of expandTerm(t)) out.add(e);
  return Array.from(out);
}

/** Exposed for tests + future tooling (e.g., admin UI to inspect the
 *  dictionary). Do not mutate. */
export const SYNONYM_GROUPS: ReadonlyArray<SynonymGroup> = RAW_GROUPS;
