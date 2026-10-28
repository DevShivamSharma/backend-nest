/** Resolves every promise inside a value (a returned object may hold promises), deeply. */
async function deepResolvePromises(input: unknown): Promise<unknown> {
  if (input instanceof Promise) {
    return await input;
  }

  if (Array.isArray(input)) {
    return await Promise.all(input.map(deepResolvePromises));
  }

  if (input instanceof Date) {
    return input;
  }

  if (typeof input === 'object' && input !== null) {
    const resolvedObject: Record<string, unknown> = {};

    for (const key of Object.keys(input)) {
      resolvedObject[key] = await deepResolvePromises((input as Record<string, unknown>)[key]);
    }

    return resolvedObject;
  }

  return input;
}

export default deepResolvePromises;
