# Artifacts are isolated by the browser sandbox, not a second hostname

Artifacts are HTML that agents write, so they must never act as the signed-in User. The first Cronk served them from a separate hostname (its ADR 0007). This rewrite serves them from Cronk's own hostname with a `Content-Security-Policy: sandbox` header (without `allow-same-origin`) and shows them in a sandboxed iframe, so each page runs with an opaque origin: scripts work, but it can't read Cronk's cookies or call its API, even when opened directly. One hostname keeps setup simple behind a tunnel; a separate Artifact hostname stays available as an optional setting for those who want both layers.

## Considered Options

- **A required second hostname**: the strongest isolation, but a second domain and certificate for every installation, including tunnelled development ones.
