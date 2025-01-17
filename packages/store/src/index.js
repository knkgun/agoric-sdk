// @ts-check

export { isKey, assertKey } from './keys/checkKey.js';
export { keyLT, keyLTE, keyEQ, keyGTE, keyGT } from './keys/compareKeys.js';

export { makePatternKit } from './patterns/patternMatchers.js';
export { compareRank } from './patterns/rankOrder.js';

export { makeScalarWeakSetStore } from './stores/scalarWeakSetStore.js';
export { makeScalarSetStore } from './stores/scalarSetStore.js';
export {
  makeScalarWeakMapStore,
  makeScalarWeakMapStore as makeScalarWeakMap, // Deprecated legacy
  makeScalarWeakMapStore as makeWeakStore, // Deprecated legacy
} from './stores/scalarWeakMapStore.js';
export {
  makeScalarMapStore,
  makeScalarMapStore as makeScalarMap, // Deprecated legacy
  makeScalarMapStore as makeStore, // Deprecated legacy
} from './stores/scalarMapStore.js';

// /////////////////////// Deprecated Legacy ///////////////////////////////////

// export default as well as makeLegacy* only for compatibility
// during the transition.
export { makeLegacyMap, makeLegacyMap as default } from './legacy/legacyMap.js';
export { makeLegacyWeakMap } from './legacy/legacyWeakMap.js';
