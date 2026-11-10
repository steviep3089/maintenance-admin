// Coordinates the intentional sign-out after a successful password setup so the
// SIGNED_OUT listener does not dismiss the "Password Updated" screen.
let pending = false;

export function markPasswordSetupSignOut() {
  pending = true;
}

export function clearPasswordSetupSignOut() {
  pending = false;
}

// Returns true once for the intentional sign-out, and clears the flag.
export function consumePasswordSetupSignOut() {
  const was = pending;
  pending = false;
  return was;
}
