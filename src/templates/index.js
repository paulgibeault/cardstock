import shedding from './shedding.js';
import trickTaking from './trick-taking.js';
import contractRummy from './contract-rummy.js';
import sequencing from './sequencing.js';

const TEMPLATES = {
  shedding,
  'trick-taking': trickTaking,
  'contract-rummy': contractRummy,
  sequencing,
};

export function getTemplate(id) {
  const t = TEMPLATES[id];
  if (!t) throw new Error(`Unknown template: ${id}`);
  return t;
}
