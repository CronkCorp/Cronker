/** Browser storage can be unavailable, such as in a private window; nothing here depends on it. */
export function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

const returnAfterSignInKey = "cronk_return_after_sign_in";

/** Remembers a page to come back to once signed in, for a sign-in that leaves Cronk, such as with GitHub. */
export function returnAfterSignIn(path: string): void {
  safely(() => sessionStorage.setItem(returnAfterSignInKey, path));
}

/** The page to come back to after signing in, if one was remembered; it is forgotten once taken. */
export function takeReturnAfterSignIn(): string | undefined {
  const path = safely(() => sessionStorage.getItem(returnAfterSignInKey)) ?? undefined;
  if (path) safely(() => sessionStorage.removeItem(returnAfterSignInKey));
  return path;
}
