const returnedChildSessionIds = new Set<string>()

export function markChildReturned(childSessionId: string): void {
  returnedChildSessionIds.add(childSessionId)
}

export function hasChildReturned(childSessionId: string): boolean {
  return returnedChildSessionIds.has(childSessionId)
}

export function resetGenericAgentReturnRegistryForTesting(): void {
  returnedChildSessionIds.clear()
}
