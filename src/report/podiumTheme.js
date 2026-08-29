// JavaScript Document
//
// The "Championship" report theme shared by the two podium-style HTML
// reports: the main CLI's out/report.html (src/report/index.js's
// renderReportHtml) and the GA's my-teams-evolve.html
// (scripts/evolve.mjs's renderEvolveReportHtml). Pure strings -- no engine,
// no I/O.
//
// Ported as directly as possible from out/artifact-sources/podium-report.html
// (the hand-built reference Jaxon liked) -- same tokens, same component
// sizes, same section chrome. The only substitutions: its two Google Fonts
// (Barlow Condensed / Source Sans 3) become system stacks that approximate
// them (these reports make zero external requests), and its fixed --blue
// link/button accent becomes --accent, filled from the run's own league
// (src/util/leagues.js's group) rather than a constant -- the ONE restrained
// accent slot the reference itself has, not a new one.

/**
 * Accent color per pvpoke league group (src/util/leagues.js) -- a Great
 * League report reads differently from a Master League one because they ARE
 * different formats, not as a decorative flourish. `accent` is the
 * light-mode slot, `accentHi` the dark-mode one.
 */
export const LEAGUE_ACCENTS = Object.freeze({
  little: { accent: '#2F66C4', accentHi: '#7BA3F0' },
  great: { accent: '#2E8B57', accentHi: '#6FCB94' },
  ultra: { accent: '#C1611F', accentHi: '#F0A25E' },
  master: { accent: '#6E4AAE', accentHi: '#B79AE8' },
});

/**
 * The full Championship stylesheet (everything between the report's
 * `<style>` tags). Includes selectors only one of the two reports uses
 * (e.g. `.race-embed` is GA-only) -- unused rules cost nothing and keeping
 * one stylesheet keeps the two reports pixel-identical where they overlap.
 *
 * @param {{accent: string, accentHi: string}} accents - one LEAGUE_ACCENTS entry.
 * @returns {string} CSS text.
 */
export function championshipCss(accents) {
  return `
  :root { color-scheme: light dark; }
  :root {
    --ground: #F4F7FB; --card: #FFFFFF; --card-2: #EDF1F7; --ink: #1A2233; --muted: #5B6779;
    --line: #D9E0EA; --gold: #C0951C; --gold-hi: #E8C25A; --silver: #8E9AA9; --silver-hi: #C4CDD8;
    --bronze: #A96A38; --bronze-hi: #D19A64; --accent: ${accents.accent};
    --shadow: 0 1px 2px rgba(16,27,51,0.06), 0 8px 24px rgba(16,27,51,0.07);
    --display: "Arial Narrow", "Helvetica Neue", sans-serif;
    --body: -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #0F1626; --card: #182138; --card-2: #1F2A47; --ink: #E8EDF6; --muted: #9AA7BC;
      --line: #2C3A5C; --gold: #E8C25A; --gold-hi: #F6DE9A; --silver: #A7B2C2; --silver-hi: #CBD4DF;
      --bronze: #CE8F55; --bronze-hi: #E4B285; --accent: ${accents.accentHi};
      --shadow: 0 1px 2px rgba(0,0,0,0.35), 0 10px 30px rgba(0,0,0,0.35);
    }
  }
  :root[data-theme="dark"] {
    --ground: #0F1626; --card: #182138; --card-2: #1F2A47; --ink: #E8EDF6; --muted: #9AA7BC;
    --line: #2C3A5C; --gold: #E8C25A; --gold-hi: #F6DE9A; --silver: #A7B2C2; --silver-hi: #CBD4DF;
    --bronze: #CE8F55; --bronze-hi: #E4B285; --accent: ${accents.accentHi};
    --shadow: 0 1px 2px rgba(0,0,0,0.35), 0 10px 30px rgba(0,0,0,0.35);
  }
  body {
    background: var(--ground); color: var(--ink);
    font-family: var(--body); font-size: 16px; line-height: 1.55; margin: 0;
  }
  .wrap { max-width: 62rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
  .eyebrow {
    font-family: var(--display); font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase;
    font-size: 0.85rem; color: var(--muted); text-align: center; margin: 0 0 0.35rem;
  }
  h1 {
    font-family: var(--display); font-weight: 700; font-size: clamp(2.4rem, 6vw, 3.6rem);
    line-height: 1.04; text-align: center; text-wrap: balance; margin: 0 0 0.4rem;
  }
  .sub { text-align: center; color: var(--muted); max-width: 42rem; margin: 0 auto 2.75rem; }
  .sub strong { color: var(--ink); }

  /* ------- podium ------- */
  .podium { display: grid; gap: 10px; align-items: end; margin: 0 auto 0.75rem; max-width: 56rem; }
  .step { text-align: center; }
  .team { font-family: var(--display); font-weight: 600; font-size: clamp(1rem, 2.4vw, 1.35rem); line-height: 1.22; margin-bottom: 0.6rem; }
  .team .mon { display: block; }
  .team .lead-tag {
    display: inline-block; vertical-align: 0.08em; margin-left: 0.3rem;
    font-size: 0.62em; font-weight: 600; letter-spacing: 0.12em;
    color: var(--muted); border: 1px solid var(--line); border-radius: 3px; padding: 0 0.3em;
  }
  .medal-badge {
    width: 2.6rem; height: 2.6rem; margin: 0 auto 0.55rem; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-family: var(--display); font-weight: 700; font-size: 1.35rem;
    color: #241A05; box-shadow: var(--shadow);
  }
  .block {
    border-radius: 6px 6px 0 0; box-shadow: var(--shadow);
    display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
    padding-top: 0.65rem; color: #101626;
  }
  .block .score {
    font-family: var(--display); font-weight: 700; font-size: clamp(1.7rem, 4vw, 2.3rem); line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .block .score-label { font-size: 0.7rem; letter-spacing: 0.14em; text-transform: uppercase; opacity: 0.75; font-weight: 600; }
  .p1 .block { height: 9.5rem; background: linear-gradient(180deg, var(--gold-hi), var(--gold)); }
  .p2 .block { height: 6.9rem; background: linear-gradient(180deg, var(--silver-hi), var(--silver)); }
  .p3 .block { height: 5.6rem; background: linear-gradient(180deg, var(--bronze-hi), var(--bronze)); }
  .p1 .medal-badge { background: linear-gradient(160deg, var(--gold-hi), var(--gold)); }
  .p2 .medal-badge { background: linear-gradient(160deg, var(--silver-hi), var(--silver)); }
  .p3 .medal-badge { background: linear-gradient(160deg, var(--bronze-hi), var(--bronze)); }
  .podium-note { text-align: center; color: var(--muted); font-size: 0.9rem; margin: 0 0 3rem; }

  /* ------- shared section chrome ------- */
  section { margin-top: 3rem; }
  h2 {
    font-family: var(--display); font-weight: 700; font-size: 1.7rem; letter-spacing: 0.01em;
    margin: 0 0 1rem; display: flex; align-items: baseline; gap: 0.6rem;
  }
  h2 .rule { flex: 1; border-top: 1px solid var(--line); transform: translateY(-0.35rem); }

  /* ------- medalist / roster cards ------- */
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    box-shadow: var(--shadow); padding: 1.25rem 1.4rem; margin-bottom: 1.25rem;
    border-top: 4px solid var(--line);
  }
  .card.gold { border-top-color: var(--gold); }
  .card.silver { border-top-color: var(--silver); }
  .card.bronze { border-top-color: var(--bronze); }
  .scoreline { color: var(--muted); font-size: 0.92rem; margin: 0 0 0.9rem; }
  .scoreline b { color: var(--ink); font-variant-numeric: tabular-nums; }
  table { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
  .roster-wrap, .table-wrap { overflow-x: auto; }
  th {
    text-align: left; font-size: 0.72rem; letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--muted); font-weight: 600; padding: 0.45rem 0.9rem 0.35rem 0; border-bottom: 1px solid var(--line);
  }
  td { padding: 0.5rem 0.9rem 0.5rem 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; padding-right: 0; }
  .movestr { color: var(--muted); }
  .movestr b { color: var(--ink); font-weight: 600; }
  .build { font-size: 0.88rem; color: var(--muted); }
  .build b { color: var(--ink); }
  .factline { margin: 0.85rem 0 0; font-size: 0.92rem; color: var(--muted); }
  .factline b { color: var(--ink); }
  .breakers { margin: 0.35rem 0 0; font-size: 0.92rem; color: var(--muted); }
  .breakers b { color: var(--ink); }

  /* ------- race (embedded live chart) ------- */
  .race-embed {
    background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    box-shadow: var(--shadow); padding: 1rem 1.1rem; margin-bottom: 1.1rem;
  }
  .race-embed .controls { display: flex; gap: 0.75rem; align-items: center; margin: 0 0 0.75rem; }
  .race-embed button {
    font: 600 0.92rem var(--body); color: var(--ground); background: var(--accent);
    border: 0; border-radius: 6px; padding: 0.42rem 1.1rem; min-width: 5.2rem; cursor: pointer;
  }
  .race-embed button:focus-visible, .race-embed input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .race-embed input[type=range] { flex: 1; accent-color: var(--accent); margin: 0; }
  .race-embed #genlabel { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 0.9rem; white-space: nowrap; }
  .race-embed #picked { min-height: 1.5em; margin: 0 0 0.5rem; font-size: 0.92rem; color: var(--muted); }
  .race-embed .chart-scroll { overflow-x: auto; }
  .race-embed svg { display: block; width: 100%; height: auto; min-width: 640px; }
  .race-embed .grid { stroke: rgba(127,127,127,0.18); }
  .race-embed text { fill: currentColor; font-size: 12px; }
  .race-embed .legend {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(15.5rem, 1fr));
    gap: 0.2rem 1rem; list-style: none; padding: 0; margin: 0.75rem 0 0; font-size: 0.88rem;
  }
  .race-embed .legend li { display: flex; align-items: center; gap: 0.45rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .race-embed .legend .swatch { width: 1.05em; height: 0.32em; border-radius: 0.18em; flex: none; }

  /* ------- standings + notes ------- */
  .standings td:first-child { font-variant-numeric: tabular-nums; color: var(--muted); }
  .medal-dot { display: inline-block; width: 0.62em; height: 0.62em; border-radius: 50%; margin-right: 0.4em; vertical-align: 0.02em; }
  ul.notes { padding-left: 1.15rem; margin: 0; }
  ul.notes li { margin-bottom: 0.5rem; }
  ul.notes b { font-weight: 600; }
  code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.85em; background: var(--card-2);
    border: 1px solid var(--line); border-radius: 4px; padding: 0.06em 0.35em;
  }
  a { color: var(--accent); }
  .foot { margin-top: 3rem; color: var(--muted); font-size: 0.85rem; border-top: 1px solid var(--line); padding-top: 1rem; }

  @media (max-width: 560px) {
    .team .mon { font-size: 0.95em; }
    .card { padding: 1rem; }
  }

  /* The reference animates only .step; extended (Jaxon's ask) to cover the
     title/description too, as one staggered reveal -- still fully
     reduced-motion guarded, same as the reference's own rule. */
  @media (prefers-reduced-motion: no-preference) {
    .eyebrow, h1, .sub, .podium-note { animation: rise 0.7s cubic-bezier(0.2, 0.7, 0.2, 1) backwards; }
    h1 { animation-delay: 0.1s; }
    .step { animation: rise 0.8s cubic-bezier(0.2, 0.7, 0.2, 1) backwards; }
    .p1 { animation-delay: 0.25s; } .p2 { animation-delay: 0.45s; } .p3 { animation-delay: 0.6s; }
    .sub { animation-delay: 0.8s; } .podium-note { animation-delay: 0.95s; }
    @keyframes rise { from { transform: translateY(14px); opacity: 0; } to { transform: none; opacity: 1; } }
  }
`;
}
