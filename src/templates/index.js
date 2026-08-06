import shedding from './shedding.js';
import trickTaking from './trick-taking.js';
import contractRummy from './contract-rummy.js';
import sequencing from './sequencing.js';
import { templateInfo } from './registry.js';

const TEMPLATES = {
  shedding,
  'trick-taking': trickTaking,
  'contract-rummy': contractRummy,
  sequencing,
};

// The presentation facts (genre word, default card art, playable-to-the-end)
// live in registry.js so the lobby can read them without loading a template.
// Stamped on here so gameplay code, which HAS the template object, reads them
// off it rather than knowing the registry exists.
for (const [id, template] of Object.entries(TEMPLATES)) {
  Object.assign(template, templateInfo(id));
}

export const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));

export function getTemplate(id) {
  const t = TEMPLATES[id];
  if (!t) throw new Error(`Unknown template: ${id}`);
  return t;
}
