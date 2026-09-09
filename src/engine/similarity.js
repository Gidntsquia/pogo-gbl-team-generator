// Species similarity for the core-rivalry penalty (src/meta/archetypes.js),
// scored by pvpoke's own Pokemon#calculateSimilarity -- the metric behind the
// "Similar Pokemon" list on pvpoke's rankings pages. Nothing here is
// reimplemented: this module only calls the vendored method, drops its
// ranking multiplier, and normalises the raw additive score into 0..1.
//
// pvpoke's raw score is a sum of: +400 per shared type, +350 for the same
// fast move, +200 per shared charged move id, and +50..+450 per shared
// trait from Pokemon#generateTraits (bulk tier, spammy/slow, agile/clumsy,
// flexible/inflexible, fast-move/shield pressure, defensive/vulnerable,
// chaotic/momentum/technical/dynamic/inconsistent). The "same move TYPE"
// fallbacks in the vendored code compare a type to a move id and never fire,
// so exact move ids, shared types and traits are what count. With
// factorRanking=false the score is symmetric in its two arguments.
//
// Normalisation: score(a,b) / sqrt(score(a,a) * score(b,b)) -- cosine-like,
// so 1 means "identical types, moveset and traits" and a mon that shares
// only one type with another sits well under 0.3. The self score is what
// the vendored method returns when the "same species" short-circuit is
// side-stepped by handing it a prototype-proxy of the mon with a foreign id.

/**
 * Cache key of one built pvpoke Pokemon for similarity purposes: species
 * (shadow-distinct, since bulk traits read the shadow multipliers), fast move
 * and charged moves. Two builds that agree on these score identically.
 *
 * @param {object} p - a built pvpoke Pokemon (harness buildPokemon / sampleTeams buildMetaMon).
 * @returns {string}
 */
export function similarityKey(p) {
  const charged = (p.chargedMoves ?? []).map((m) => (m ? m.moveId : '-')).sort().join(',');
  return `${p.speciesId}|${p.fastMove ? p.fastMove.moveId : '-'}|${charged}`;
}

/**
 * Build a memoised pvpoke similarity scorer. Pokemon objects must come from
 * the same initEngine context (traits read that context's CP cap and
 * rankings). Traits and self scores are cached per similarityKey, pair
 * scores per key pair, so an evolve run pays for each distinct pair once.
 *
 * @returns {(a: object, b: object) => number} normalised similarity in
 *   [0, 1]; 1 for the same species (pvpoke's own short-circuit, shadow and
 *   base included) and 0 when either object cannot be scored.
 */
export function createSimilarity() {
  const traits = new Map();
  const selfScore = new Map();
  const pairs = new Map();

  const traitsOf = (p) => {
    const key = similarityKey(p);
    let t = traits.get(key);
    if (!t) {
      t = p.generateTraits();
      traits.set(key, t);
    }
    return t;
  };
  const selfOf = (p) => {
    const key = similarityKey(p);
    let s = selfScore.get(key);
    if (s === undefined) {
      // Same-species short-circuit returns -1, so score the mon against a
      // proxy of itself that carries a foreign id but every other field.
      const proxy = Object.create(p, { speciesId: { value: `${p.speciesId}__self` } });
      s = p.calculateSimilarity(proxy, traitsOf(p), false);
      selfScore.set(key, s);
    }
    return s;
  };

  return (a, b) => {
    if (!a || !b || typeof a.calculateSimilarity !== 'function' || typeof b.calculateSimilarity !== 'function') return 0;
    const ka = similarityKey(a);
    const kb = similarityKey(b);
    const key = ka < kb ? `${ka}||${kb}` : `${kb}||${ka}`;
    let v = pairs.get(key);
    if (v === undefined) {
      const raw = a.calculateSimilarity(b, traitsOf(a), false);
      if (raw < 0) v = 1;
      else {
        const denom = Math.sqrt(selfOf(a) * selfOf(b));
        v = denom > 0 ? Math.min(1, Math.max(0, raw / denom)) : 0;
      }
      pairs.set(key, v);
    }
    return v;
  };
}
