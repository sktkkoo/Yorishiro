export interface WindowAspectRatioStrategy {
  readonly nativeAspectRatio: number | null;
  readonly jsAspectRatio: number | null;
}

export function resolveWindowAspectRatioStrategy(
  _aspectRatio: number | undefined,
  _macos: boolean,
): WindowAspectRatioStrategy {
  return { nativeAspectRatio: null, jsAspectRatio: null };
}

let nativeWindowMutationQueue = Promise.resolve();

export function enqueueNativeWindowMutation(operation: () => Promise<void>): Promise<void> {
  const result = nativeWindowMutationQueue.then(operation);
  nativeWindowMutationQueue = result.catch(() => undefined);
  return result;
}
