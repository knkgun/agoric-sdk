/* global BigUint64Array */
// @ts-check
import { assert, details as X, q } from '@agoric/assert';
import { makePatternKit, compareRank } from '@agoric/store';
import {
  passStyleOf,
  nameForPassableSymbol,
  passableSymbolForName,
} from '@agoric/marshal';
import { parseVatSlot } from '../parseVatSlots.js';

function zeroPad(n, size) {
  const str = `000000000000000000${n}`;
  return str.substring(str.length - size);
}

// This is the JavaScript analog to a C union: a way to map between a float as a
// number and the bits that represent the float as a buffer full of bytes.  Note
// that the mutation of static state here makes this invalid Jessie code, but
// doing it this way saves the nugatory and gratuitous allocations that would
// happen every time you do a conversion -- and in practical terms it's safe
// because we put the value in one side and then immediately take it out the
// other; there is no actual state retained in the classic sense and thus no
// re-entrancy issue.
const asNumber = new Float64Array(1);
const asBits = new BigUint64Array(asNumber.buffer);

function numberToDBEntryKey(n) {
  asNumber[0] = n;
  let bits = asBits[0];
  if (n < 0) {
    // XXX Why is the no-bitwise lint rule even a thing??
    // eslint-disable-next-line no-bitwise
    bits ^= 0xffffffffffffffffn;
  } else {
    // eslint-disable-next-line no-bitwise
    bits ^= 0x8000000000000000n;
  }
  return `f${zeroPad(bits.toString(16), 16)}`;
}

function dbEntryKeyToNumber(k) {
  let bits = BigInt(`0x${k.substring(1)}`);
  if (k[0] < '8') {
    // eslint-disable-next-line no-bitwise
    bits ^= 0xffffffffffffffffn;
  } else {
    // eslint-disable-next-line no-bitwise
    bits ^= 0x8000000000000000n;
  }
  asBits[0] = bits;
  return asNumber[0];
}

const BIGINT_TAG_LEN = 10;
const BIGINT_LEN_MODULUS = 10 ** BIGINT_TAG_LEN;

function bigintToDBEntryKey(n) {
  if (n < 0n) {
    const raw = (-n).toString();
    const modulus = 10n ** BigInt(raw.length);
    const numstr = (modulus + n).toString(); // + because n is negative
    const lenTag = zeroPad(BIGINT_LEN_MODULUS - raw.length, BIGINT_TAG_LEN);
    return `n${lenTag}:${zeroPad(numstr, raw.length)}`;
  } else {
    const numstr = n.toString();
    return `p${zeroPad(numstr.length, BIGINT_TAG_LEN)}:${numstr}`;
  }
}

function dbEntryKeyToBigint(k) {
  const numstr = k.substring(BIGINT_TAG_LEN + 2);
  const n = BigInt(numstr);
  if (k[0] === 'n') {
    const modulus = 10n ** BigInt(numstr.length);
    return -(modulus - n);
  } else {
    return n;
  }
}

function pattEq(p1, p2) {
  return compareRank(p1, p2) === 0;
}

let nextCollectionID = 1;

function allocateCollectionID() {
  const collectionID = nextCollectionID;
  nextCollectionID += 1;
  return collectionID;
}

export function makeCollectionManager(
  syscall,
  vrm,
  allocateExportID,
  getSlotForVal,
  getValForSlot,
  registerEntry,
  serialize,
  unserialize,
) {
  const { getRankCover, assertKeyPattern, matches, M } = makePatternKit();

  const storeKindIDToName = new Map();

  let storeKindInfoNeedsInitialization = true;
  const storeKindInfo = {
    scalarMapStore: {
      hasWeakKeys: false,
      kindID: 0,
      // eslint-disable-next-line no-use-before-define
      reanimator: reanimateScalarMapStore,
    },
    scalarWeakMapStore: {
      hasWeakKeys: true,
      kindID: 0,
      // eslint-disable-next-line no-use-before-define
      reanimator: reanimateScalarWeakMapStore,
    },
    scalarSetStore: {
      hasWeakKeys: false,
      kindID: 0,
      // eslint-disable-next-line no-use-before-define
      reanimator: reanimateScalarSetStore,
    },
    scalarWeakSetStore: {
      hasWeakKeys: true,
      kindID: 0,
      // eslint-disable-next-line no-use-before-define
      reanimator: reanimateScalarWeakSetStore,
    },
  };

  function obtainStoreKindID(kindName) {
    if (storeKindInfoNeedsInitialization) {
      storeKindInfoNeedsInitialization = false;

      let storeKindIDs = {};
      const rawTable = syscall.vatstoreGet('storeKindIDTable');
      if (rawTable) {
        storeKindIDs = JSON.parse(rawTable);
      }
      for (const kind of Object.getOwnPropertyNames(storeKindInfo)) {
        let kindID = storeKindIDs[kind];
        if (!kindID) {
          kindID = allocateExportID();
          storeKindIDs[kind] = kindID;
        }
        storeKindInfo[kind].kindID = kindID;
        storeKindIDToName.set(kindID, kind);
        vrm.registerReanimator(kindID, storeKindInfo[kind].reanimator);
      }
      syscall.vatstoreSet('storeKindIDTable', JSON.stringify(storeKindIDs));
    }
    return storeKindInfo[kindName].kindID;
  }

  function summonCollection(
    label,
    collectionID,
    kindName,
    keySchema = M.scalar(),
  ) {
    const hasWeakKeys = storeKindInfo[kindName].hasWeakKeys;
    const dbKeyPrefix = `vc.${collectionID}.`;
    let currentGenerationNumber = 0;

    // XXX size should be stored persistently, either explicitly or implicitly,
    // but I'm concerned about the cost.  In the explicit case we pay for an
    // extra database write each time `init` or `delete` is called, to increment
    // or decrement a size counter stored in the DB.  In the implicit case we
    // would pay a one-time O(n) cost at startup time to count the number of
    // entries that were there when we last exited (actually, this could be done
    // lazily instead of at startup, which could save the cost in the likely
    // common case where nobody ever looks at the size property, but it would
    // still be O(n) when and if it happens).  Neither of these alternatives
    // seems appetizing.
    let size = 0;

    function prefix(dbEntryKey) {
      return `${dbKeyPrefix}${dbEntryKey}`;
    }

    function encodeKey(key) {
      const passStyle = passStyleOf(key);
      switch (passStyle) {
        case 'null':
          return 'z';
        case 'undefined':
          return 'u';
        case 'number':
          return numberToDBEntryKey(key);
        case 'string':
          return `s${key}`;
        case 'boolean':
          return `b${key}`;
        case 'bigint':
          return bigintToDBEntryKey(key);
        case 'remotable': {
          // eslint-disable-next-line no-use-before-define
          const ordinal = getOrdinal(key);
          assert(ordinal !== undefined, X`no ordinal for ${key}`);
          const ordinalTag = zeroPad(ordinal, BIGINT_TAG_LEN);
          return `r${ordinalTag}:${getSlotForVal(key)}`;
        }
        case 'symbol':
          return `y${nameForPassableSymbol(key)}`;
        default:
          assert.fail(X`a ${q(passStyle)} cannot be used as a collection key`);
      }
    }

    function generateOrdinal(remotable) {
      const nextOrdinal = Number.parseInt(
        syscall.vatstoreGet(prefix('|nextOrdinal')),
        10,
      );
      syscall.vatstoreSet(
        prefix(`|${getSlotForVal(remotable)}`),
        `${nextOrdinal}`,
      );
      syscall.vatstoreSet(prefix('|nextOrdinal'), `${nextOrdinal + 1}`);
    }

    function getOrdinal(remotable) {
      return syscall.vatstoreGet(prefix(`|${getSlotForVal(remotable)}`));
    }

    function deleteOrdinal(remotable) {
      syscall.vatstoreDelete(prefix(`|${getSlotForVal(remotable)}`));
    }

    /*
    function isValueSchema(schema) {
      return pattEq(schema, M.any());
    }

    function assertValueSchema(schema) {
      assert(
        isValueSchema(schema),
        X`not a supported schema for collection values`,
      );
    }
    */

    function isValuePattern(patt) {
      return pattEq(patt, M.any());
    }

    function assertValuePattern(patt) {
      assert(
        isValuePattern(patt),
        X`not a supported pattern for collection values`,
      );
    }

    function keyToDBKey(key) {
      return prefix(encodeKey(key));
    }

    function dbKeyToKey(dbKey) {
      const dbEntryKey = dbKey.substring(dbKeyPrefix.length);
      switch (dbEntryKey[0]) {
        case 'z':
          return null;
        case 'u':
          return undefined;
        case 'f':
          return dbEntryKeyToNumber(dbEntryKey);
        case 's':
          return dbEntryKey.substring(1);
        case 'b':
          return dbEntryKey.substring(1) !== 'false';
        case 'n':
        case 'p':
          return dbEntryKeyToBigint(dbEntryKey);
        case 'r':
          return getValForSlot(dbEntryKey.substring(BIGINT_TAG_LEN + 2));
        case 'y':
          return passableSymbolForName(dbEntryKey.substring(1));
        default:
          assert.fail(X`invalid database key: ${dbEntryKey}`);
      }
    }

    function has(key) {
      if (!matches(key, keySchema)) {
        return false;
      }
      if (passStyleOf(key) === 'remotable') {
        return getOrdinal(key) !== undefined;
      } else {
        return syscall.vatstoreGet(keyToDBKey(key)) !== undefined;
      }
    }

    function get(key) {
      assert(
        matches(key, keySchema),
        X`invalid key type for collection ${q(label)}`,
      );
      const result = syscall.vatstoreGet(keyToDBKey(key));
      if (result) {
        return unserialize(JSON.parse(result));
      }
      assert.fail(X`key ${key} not found in collection ${q(label)}`);
    }

    function entryDeleter(vobjID) {
      const ordinalKey = prefix(`|${vobjID}`);
      const ordinalString = syscall.vatstoreGet(ordinalKey);
      syscall.vatstoreDelete(ordinalKey);
      const ordinalTag = zeroPad(ordinalString, BIGINT_TAG_LEN);
      syscall.vatstoreDelete(prefix(`r${ordinalTag}:${vobjID}`));
    }

    function init(key, value) {
      assert(
        matches(key, keySchema),
        X`invalid key type for collection ${q(label)}`,
      );
      assert(
        !has(key),
        X`key ${key} already registered in collection ${q(label)}`,
      );
      currentGenerationNumber += 1;
      if (passStyleOf(key) === 'remotable') {
        generateOrdinal(key);
        if (hasWeakKeys) {
          vrm.addRecognizableValue(key, entryDeleter);
        } else {
          vrm.addReachableVref(getSlotForVal(key));
        }
      }
      const serializedValue = serialize(value);
      serializedValue.slots.map(vrm.addReachableVref);
      syscall.vatstoreSet(keyToDBKey(key), JSON.stringify(serializedValue));
      size += 1;
    }

    function set(key, value) {
      assert(
        matches(key, keySchema),
        X`invalid key type for collection ${q(label)}`,
      );
      const dbKey = keyToDBKey(key);
      const rawBefore = syscall.vatstoreGet(dbKey);
      assert(rawBefore, X`key ${key} not found in collection ${q(label)}`);
      const before = JSON.parse(rawBefore);
      const after = serialize(harden(value));
      vrm.updateReferenceCounts(before.slots, after.slots);
      syscall.vatstoreSet(dbKey, JSON.stringify(after));
    }

    function deleteInternal(key) {
      assert(
        matches(key, keySchema),
        X`invalid key type for collection ${q(label)}`,
      );
      const dbKey = keyToDBKey(key);
      const rawValue = syscall.vatstoreGet(dbKey);
      assert(rawValue, X`key ${key} not found in collection ${q(label)}`);
      const value = JSON.parse(rawValue);
      value.slots.map(vrm.removeReachableVref);
      syscall.vatstoreDelete(dbKey);
      if (passStyleOf(key) === 'remotable') {
        if (hasWeakKeys) {
          vrm.removeRecognizableValue(key, entryDeleter);
        } else {
          vrm.removeReachableVref(getSlotForVal(key));
        }
        deleteOrdinal(key);
      }
      size -= 1;
    }

    function del(key) {
      currentGenerationNumber += 1;
      deleteInternal(key);
    }

    function entriesInternal(
      needValue,
      keyPatt = M.any(),
      valuePatt = M.any(),
    ) {
      assertKeyPattern(keyPatt);
      assertValuePattern(valuePatt);
      const [coverStart, coverEnd] = getRankCover(keyPatt, encodeKey);
      let priorDBKey = '';
      const start = prefix(coverStart);
      const end = prefix(coverEnd);
      const ignoreValues = !needValue && pattEq(valuePatt, M.any());
      function* iter() {
        const generationAtStart = currentGenerationNumber;
        while (priorDBKey !== undefined) {
          assert(generationAtStart === currentGenerationNumber);
          const getAfterResult = syscall.vatstoreGetAfter(
            priorDBKey,
            start,
            end,
          );
          if (!getAfterResult) {
            break;
          }
          const [dbKey, dbValue] = getAfterResult;
          if (dbKey < end) {
            priorDBKey = dbKey;
            const key = dbKeyToKey(dbKey);
            if (matches(key, keyPatt)) {
              // Skip unserializing value if we're never going to look at it
              let value;
              if (!ignoreValues) {
                value = unserialize(JSON.parse(dbValue));
                if (!matches(value, valuePatt)) {
                  // eslint-disable-next-line no-continue
                  continue;
                }
              }
              yield [key, value];
            }
          }
        }
      }
      return iter();
    }

    function keys(keyPatt, valuePatt) {
      function* iter() {
        for (const entry of entriesInternal(false, keyPatt, valuePatt)) {
          yield entry[0];
        }
      }
      return iter();
    }

    function clear(keyPatt, valuePatt) {
      for (const k of keys(keyPatt, valuePatt)) {
        deleteInternal(k);
      }
      currentGenerationNumber += 1;
    }

    function values(keyPatt, valuePatt) {
      function* iter() {
        for (const entry of entriesInternal(true, keyPatt, valuePatt)) {
          yield entry[1];
        }
      }
      return iter();
    }

    function entries(keyPatt, valuePatt) {
      function* iter() {
        for (const entry of entriesInternal(true, keyPatt, valuePatt)) {
          yield entry;
        }
      }
      return iter();
    }

    const weakMethods = {
      has,
      get,
      init,
      set,
      delete: del,
    };

    function collectionDeleter(descriptor) {
      clear();
      let priorKey = '';
      const { keyPrefix } = descriptor;
      while (priorKey !== undefined) {
        const getAfterResult = syscall.vatstoreGetAfter(priorKey, keyPrefix);
        if (!getAfterResult) {
          break;
        }
        priorKey = getAfterResult[0];
        syscall.vatstoreDelete(priorKey);
      }
    }

    let collection;
    if (hasWeakKeys) {
      collection = harden(weakMethods);
    } else {
      collection = harden({
        ...weakMethods,
        keys,
        values,
        entries,
        clear,
        get size() {
          return size;
        },
      });
    }
    vrm.droppedCollectionRegistry.register(collection, {
      collectionDeleter,
      keyPrefix: prefix('|'),
    });
    return collection;
  }

  function prefixc(collectionID, dbEntryKey) {
    return `vc.${collectionID}.${dbEntryKey}`;
  }

  function makeCollection(label, kindName, keySchema = M.scalar()) {
    debugger;
    assert.typeof(label, 'string');
    assert(storeKindInfo[kindName]);
    assertKeyPattern(keySchema);
    const collectionID = allocateCollectionID();
    const kindID = obtainStoreKindID(kindName);
    const vobjID = `o+${kindID}/${collectionID}`;

    syscall.vatstoreSet(prefixc(collectionID, '|nextOrdinal'), '1');
    syscall.vatstoreSet(
      prefixc(collectionID, '|keySchema'),
      JSON.stringify(serialize(keySchema)),
    );
    syscall.vatstoreSet(prefixc(collectionID, '|label'), label);

    return [vobjID, summonCollection(label, collectionID, kindName, keySchema)];
  }

  function collectionToMapStore(collection) {
    return harden(collection);
  }

  function collectionToWeakMapStore(collection) {
    return harden(collection);
  }

  function collectionToSetStore(collection) {
    if (collection === null) {
      return null;
    }
    const { has, init, delete: del, keys, clear } = collection;
    function* entries(patt) {
      for (const k of keys(patt)) {
        yield [k, k];
      }
    }

    const setStore = {
      has,
      add: elem => init(elem, null),
      delete: del,
      keys,
      values: keys,
      entries,
      clear,
      get size() {
        return collection.size;
      },
    };
    return harden(setStore);
  }

  function collectionToWeakSetStore(collection) {
    if (collection === null) {
      return null;
    }
    const { has, init, delete: del } = collection;
    const weakSetStore = {
      has,
      add: elem => init(elem, null),
      delete: del,
    };
    return harden(weakSetStore);
  }

  function makeScalarMapStore(label, keySchema) {
    const [vobjID, collection] = makeCollection(
      label,
      'scalarMapStore',
      keySchema,
    );
    const store = collectionToMapStore(collection);
    registerEntry(vobjID, store);
    return store;
  }

  function makeScalarWeakMapStore(label, keySchema) {
    const [vobjID, collection] = makeCollection(
      label,
      'scalarWeakMapStore',
      keySchema,
    );
    const store = collectionToWeakMapStore(collection);
    registerEntry(vobjID, store);
    return store;
  }

  function makeScalarSetStore(label, keySchema) {
    const [vobjID, collection] = makeCollection(
      label,
      'scalarSetStore',
      keySchema,
    );
    const store = collectionToSetStore(collection);
    registerEntry(vobjID, store);
    return store;
  }

  function makeScalarWeakSetStore(label, keySchema) {
    const [vobjID, collection] = makeCollection(
      label,
      'scalarWeakSetStore',
      keySchema,
    );
    const store = collectionToWeakSetStore(collection);
    registerEntry(vobjID, store);
    return store;
  }

  function reanimateCollection(vobjID, proForma) {
    if (proForma) {
      return null;
    }
    const { id, subid } = parseVatSlot(vobjID);
    const kindName = storeKindIDToName.get(id);
    const keySchema = unserialize(
      JSON.parse(syscall.vatstoreGet(prefixc(subid, '|keySchema'))),
    );
    const label = syscall.vatstoreGet(prefixc(subid, '|label'));
    return summonCollection(subid, label, kindName, keySchema);
  }

  function reanimateScalarMapStore(vobjID, proForma) {
    return collectionToMapStore(reanimateCollection(vobjID, proForma));
  }

  function reanimateScalarWeakMapStore(vobjID, proForma) {
    return collectionToWeakMapStore(reanimateCollection(vobjID, proForma));
  }

  function reanimateScalarSetStore(vobjID, proForma) {
    return collectionToSetStore(reanimateCollection(vobjID, proForma));
  }

  function reanimateScalarWeakSetStore(vobjID, proForma) {
    return collectionToWeakSetStore(reanimateCollection(vobjID, proForma));
  }

  return harden({
    makeCollection,
    makeScalarMapStore,
    makeScalarWeakMapStore,
    makeScalarSetStore,
    makeScalarWeakSetStore,
    M,
  });
}
