// Keep approval and execution of one file action together. This queue is
// separate from Pi's own filesystem queue so SDK calls cannot lock themselves.
const pending = new Map<string, Promise<unknown>>();
export async function withApprovalMutationQueue<T>(
    path: string,
    execute: () => Promise<T>,
): Promise<T> {
    const previous = pending.get(path) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(execute);
    pending.set(path, task);
    try {
        return await task;
    } finally {
        if (pending.get(path) === task) pending.delete(path);
    }
}
