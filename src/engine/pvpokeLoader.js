// JavaScript Document
//
// Loads vendor/pvpoke's own battle-engine source files into a Node `vm`
// context so the rest of this package can call pvpoke's real simulator
// instead of reimplementing it. See src/engine/README.md for the full
// rationale; this file is just the sandbox + script loading.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_VENDOR_ROOT = path.resolve(__dirname, '../../vendor/pvpoke');

// pvpoke's own load order (as sequential <script src> tags on the live
// site). Every name here is a plain `var`, `function`, or `class`
// declaration in global scope -- there is no module system to preserve, so
// we don't invent one; we just run the files in the same context, in the
// same relative order, the way a browser would. (Cross-file references are
// resolved lazily inside function/method bodies, so the order isn't load
// -bearing, but keeping it matches vendor/pvpoke's own intent.)
const ENGINE_FILES = [
  'src/js/battle/DamageCalculator.js',
  'src/js/battle/timeline/TimelineAction.js',
  'src/js/battle/timeline/TimelineEvent.js',
  'src/js/battle/actions/ActionLogic.js',
  'src/js/GameMaster.js',
  'src/js/pokemon/Pokemon.js',
  'src/js/battle/Battle.js',
];

// pvpoke's Training-mode (3v3 team battle) modules, loaded on demand by
// loadTrainingModules() into a context that already has ENGINE_FILES. These
// are the only pieces needed to drive full team battles: Player (per-side
// team + shields + switch timer), TrainingAI (lead/shield/switch decision
// logic + difficulty), and DecisionOption (weighted choice struct the AI
// returns). The interface/DOM/analytics training files are deliberately NOT
// loaded -- teamBattle.js drives the turn loop itself, so nothing here
// touches jQuery or the DOM. See src/engine/teamBattle.js.
const TRAINING_FILES = [
  'src/js/training/DecisionOption.js',
  'src/js/training/TrainingAI.js',
  'src/js/pokemon/Player.js',
];

// aiArchetypes.json normally arrives via TrainingAI.js's own top-level
// `$.getJSON(...)` (a no-op under our jQuery stub), leaving its `aiData`
// global as []. We load the file ourselves and assign it into the context so
// `props = aiData[level]` in the TrainingAI constructor resolves to a real
// difficulty archetype.
const AI_ARCHETYPES_REL = 'src/data/training/aiArchetypes.json';

/**
 * Build the minimal set of browser globals pvpoke's engine code touches.
 *
 * Verified by grepping all of ENGINE_FILES for `$`, `window`, and
 * `document`: Pokemon.js, Battle.js, DamageCalculator.js, ActionLogic.js,
 * and the timeline classes reference NONE of them. Only GameMaster.js does,
 * and only for: `$.each`/`$.ajax`/`$.getJSON` (jQuery), and
 * `window.localStorage`/`window.location` on a code path this harness never
 * takes (custom-gamemaster-from-localStorage loading). Nothing here
 * performs real network I/O or touches a DOM -- initEngine loads
 * gamemaster.json and the rankings JSON directly from vendor/pvpoke/src/data
 * (see harness.js), so GameMaster's own constructor-time `$.ajax(...)` call
 * is deliberately left a no-op.
 */
function createSandbox() {
  // Tiny chainable no-op stand-in for the couple of jQuery DOM calls
  // (`$("<a>...")​.insertAfter(...)`, `$(sel).attr(...)`) that only appear
  // inside the gamemaster ajax *success* callback, which we never invoke.
  const chainable = {
    insertAfter: () => chainable,
    attr: () => undefined,
    first: () => chainable,
    eq: () => chainable,
  };

  const dollar = (_selector) => chainable;
  dollar.each = (collection, callback) => {
    if (Array.isArray(collection)) {
      collection.forEach((value, index) => callback(index, value));
    } else if (collection && typeof collection === 'object') {
      Object.keys(collection).forEach((key) => callback(key, collection[key]));
    }
    return collection;
  };
  dollar.ajax = () => undefined;
  dollar.getJSON = () => undefined;
  dollar.extend = Object.assign;

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    $: dollar,
    jQuery: dollar,
    window: {
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
      location: { href: '' },
    },
    // GameMaster.js reads these three at construction time (before
    // initEngine gets a chance to overwrite anything); values only affect
    // an ajax URL string we never fetch and a min-vs-full filename choice
    // we override by hand, so plain placeholders are fine.
    settings: {
      colorblindMode: false,
      hardMovesetLinks: false,
      gamemaster: 'gamemaster',
    },
    host: 'localhost',
    webRoot: '',
    siteVersion: '0',
  };

  return sandbox;
}

/**
 * Load pvpoke's battle-engine source files into a fresh vm context.
 *
 * @param {{ vendorRoot?: string }} [opts]
 * @returns {{ context: object, GameMaster: any, Battle: any, Pokemon: any, vendorRoot: string }}
 */
export function loadPvpokeEngine(opts = {}) {
  const vendorRoot = opts.vendorRoot ?? DEFAULT_VENDOR_ROOT;
  const sandbox = createSandbox();
  const context = vm.createContext(sandbox);

  for (const relPath of ENGINE_FILES) {
    const absPath = path.join(vendorRoot, relPath);
    let source;
    try {
      source = readFileSync(absPath, 'utf8');
    } catch (err) {
      throw new Error(
        `pvpokeLoader: could not read ${absPath} -- is vendor/pvpoke checked out? ` +
          `Run scripts/setup.sh. (${err.message})`
      );
    }
    new vm.Script(source, { filename: absPath }).runInContext(context);
  }

  const { GameMaster, Battle, Pokemon } = context;
  if (!GameMaster || !Battle || !Pokemon) {
    throw new Error(
      'pvpokeLoader: engine sandbox did not expose GameMaster/Battle/Pokemon after loading -- ' +
        'vendor/pvpoke may be on an incompatible commit.'
    );
  }

  return { context, GameMaster, Battle, Pokemon, vendorRoot };
}

/**
 * Load pvpoke's Training-mode team-battle modules (Player, TrainingAI,
 * DecisionOption) into an already-initialized engine context and populate the
 * AI archetype data. Idempotent: safe to call more than once on the same
 * context (re-running the class/function declarations is harmless and the
 * archetype assignment is just overwritten).
 *
 * @param {object} context - the vm context from loadPvpokeEngine (ctx.context)
 * @param {string} vendorRoot - ctx.vendorRoot
 * @returns {{ Player: any, TrainingAI: any, aiData: any[] }}
 */
export function loadTrainingModules(context, vendorRoot) {
  for (const relPath of TRAINING_FILES) {
    const absPath = path.join(vendorRoot, relPath);
    let source;
    try {
      source = readFileSync(absPath, 'utf8');
    } catch (err) {
      throw new Error(
        `pvpokeLoader: could not read ${absPath} -- is vendor/pvpoke checked out? ` +
          `Run scripts/setup.sh. (${err.message})`
      );
    }
    new vm.Script(source, { filename: absPath }).runInContext(context);
  }

  const aiPath = path.join(vendorRoot, AI_ARCHETYPES_REL);
  const aiData = JSON.parse(readFileSync(aiPath, 'utf8'));
  // Overwrite the empty `aiData` global that TrainingAI.js declared at load
  // time (its own $.getJSON fetch is a no-op under our stub).
  context.aiData = aiData;

  // Player is a `class` declaration, so it lives in the context's global
  // lexical scope rather than as an own-property of the global object;
  // read it back through the context instead of off `context.*`.
  const Player = vm.runInContext('Player', context);
  const TrainingAI = vm.runInContext('TrainingAI', context);
  if (!Player || !TrainingAI) {
    throw new Error(
      'pvpokeLoader: training sandbox did not expose Player/TrainingAI after loading -- ' +
        'vendor/pvpoke may be on an incompatible commit.'
    );
  }

  return { Player, TrainingAI, aiData };
}
