// ponytail: fixed ceilings keep lint time bounded; make them configurable only if real projects
// demonstrate that valid local expressions exceed them.
export const MAX_CANDIDATES = 256;
export const MAX_CANDIDATE_DEPTH = 32;

export function unionCandidates(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): Set<string> | undefined {
  const result = new Set(left);
  for (const value of right) {
    result.add(value);
    if (result.size > MAX_CANDIDATES) {
      return undefined;
    }
  }
  return result;
}

export function concatenateCandidates(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): Set<string> | undefined {
  const result = new Set<string>();
  for (const leftValue of left) {
    for (const rightValue of right) {
      result.add(leftValue + rightValue);
      if (result.size > MAX_CANDIDATES) {
        return undefined;
      }
    }
  }
  return result;
}
