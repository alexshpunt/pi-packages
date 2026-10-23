/** Makes room in an insertion-ordered set or map by forgetting its oldest entry once it holds `limit` entries. */
export function evictOldest<T>(collection: Set<T> | Map<T, unknown>, limit: number): void {
  if (collection.size >= limit) collection.delete(collection.keys().next().value!);
}
