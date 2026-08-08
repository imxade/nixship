# npm start example

This is a minimal production-shaped Node.js application whose runtime contract
is exactly:

```bash
npm run start
```

The flake supplies Node.js and npm, packages the locked application source, and
exposes `apps.<system>.default` for Nix Ship. The server stays in the foreground,
uses Nix Ship's injected `HOST` and `PORT`, and provides `GET /health`.

## Run it locally

```bash
HOST=127.0.0.1 PORT=3000 nix run .
curl http://127.0.0.1:3000/health
```

## Deploy it with Nix Ship

Push this directory as the root of a Git repository, then create a web
deployment with:

- Flake output: `default`
- Health path: `/health`

Nix Ship evaluates the flake, starts its default app, and injects runtime
variables such as `HOST`, `PORT`, `DATA_DIR`, and `DEPLOYMENT_ID`.

This dependency-free example intentionally needs no `node_modules`. For an app
with npm dependencies, use `buildNpmPackage` with a committed `package-lock.json`
and a real `npmDepsHash`; never install dependencies from the network at startup.
