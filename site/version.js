// __BUILD_ID__ is replaced with the git commit SHA at deploy time (see
// .github/workflows/deploy.yml). Locally it stays this literal, which is fine
// for dev. Both the service worker (its own copy of the literal) and the client
// caches key off this so a new deploy installs a fresh shell and discards
// derived caches whose shape may have changed across the deploy.
export const BUILD_ID = "__BUILD_ID__";
