function locatorOwners(candidates) {
  const owners = new Map();
  for (const { payload } of candidates) {
    if (
      !payload
      || typeof payload !== "object"
      || Array.isArray(payload)
      || !Array.isArray(payload.locators)
    ) {
      continue;
    }
    const id = String(payload.id);
    const lengths = owners.get(id) ?? [];
    lengths.push(payload.locators.length);
    owners.set(id, lengths);
  }
  for (const lengths of owners.values()) {
    lengths.sort((left, right) => left - right);
  }
  return owners;
}

function ownersAtIndex(lengths, index) {
  let low = 0;
  let high = lengths?.length ?? 0;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lengths[middle] <= index) low = middle + 1;
    else high = middle;
  }
  return (lengths?.length ?? 0) - low;
}

function keyOwnerCount(key, owners) {
  const separator = key.lastIndexOf("#");
  const indexText = key.slice(separator + 1);
  const index = /^\d+$/u.test(indexText) ? Number(indexText) : -1;
  if (
    separator < 0
    || !Number.isSafeInteger(index)
    || String(index) !== indexText
  ) {
    return 0;
  }
  return ownersAtIndex(owners.get(key.slice(0, separator)), index);
}

const SELECTED_HEALTH = new WeakMap();

function* unsupportedEntries(health, owners, consumed) {
  for (const key of Object.keys(health.locators).sort()) {
    const count = keyOwnerCount(key, owners);
    if (count === 1 && consumed.has(key)) continue;
    yield {
      kind: "locator_health",
      identifier: key,
      source: "indexes/locator-health.json",
      reason: count === 0
        ? "orphan_locator_health"
        : count > 1
          ? "ambiguous_locator_health"
          : "unimported_locator_health",
      ...(count > 1 ? { owners: count } : {}),
      disposition: "not_imported",
    };
  }
}

export function selectLocatorHealth(source, candidates) {
  const health = source.locatorHealth;
  if (!health) return { source, unsupported: [] };
  const owners = locatorOwners(candidates);
  const consumed = new Set();
  const selectedSource = { ...source };
  SELECTED_HEALTH.set(selectedSource, {
    health,
    owners,
    consumed,
    pending: null,
  });
  return {
    source: selectedSource,
    unsupported: unsupportedEntries(health, owners, consumed),
  };
}

export function beginLocatorHealthCandidate(source) {
  const selection = SELECTED_HEALTH.get(source);
  if (selection) selection.pending = new Set();
}

export function retainLocatorHealth(source, key) {
  SELECTED_HEALTH.get(source)?.pending?.add(key);
}

export function finishLocatorHealthCandidate(source, accepted) {
  const selection = SELECTED_HEALTH.get(source);
  if (!selection?.pending) return;
  if (accepted) {
    for (const key of selection.pending) selection.consumed.add(key);
  }
  selection.pending = null;
}

export function selectedLocatorHealth(source, key) {
  const selection = SELECTED_HEALTH.get(source);
  const health = selection?.health ?? source.locatorHealth;
  const locators = health?.locators;
  if (
    !locators
    || (
      selection
      && keyOwnerCount(key, selection.owners) !== 1
    )
    || !Object.hasOwn(locators, key)
  ) {
    return undefined;
  }
  return locators[key];
}
