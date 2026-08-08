# Deployment Contract

## Required repository files

```text
flake.nix
flake.lock
```

Nix Ship refuses an unlocked production deployment. The lock file is the reproducibility boundary for external flake inputs.

GitHub sources are materialized from an exact Git commit. Harbur sources are materialized from an
immutable ZIP whose revision and compressed content are the same SHA-256 digest. Both paths must
produce this locked flake layout before evaluation.

The flake is the locked, standard Nix entry point rather than a development-only
file. To keep concerns separate, a repository may put its production package in
`live.nix` and import it from `flake.nix`. Nix Ship evaluates only the flake
output; it never executes a loose Nix file or dashboard-provided command.

## Required output

Preferred:

```nix
apps.${system}.default = {
  type = "app";
  program = "${package}/bin/application";
};
```

Named outputs are supported and selected as `.#name` in the dashboard.

## Runtime rules

The executable must:

- stay in the foreground;
- exit non-zero on unrecoverable failure;
- write logs to stdout/stderr;
- use the injected `HOST` and `PORT` for web applications;
- store mutable durable data under `DATA_DIR`;
- avoid privileged ports, systemd, Docker, KVM, kernel modules and root-only paths.

Injected variables:

```text
MANAGED_DEPLOYMENT=1
APP_ID
APP_NAME
DEPLOYMENT_ID
RELEASE_DIR
DATA_DIR
CACHE_DIR
LOG_DIR
HOST=127.0.0.1
PORT=<candidate port>   # web apps only
```

User-defined variables cannot replace reserved names.

## Invocation

```bash
nix flake metadata --json
nix flake show --json
nix run --no-write-lock-file .#<output>
```

Nix Ship passes arguments as an array and does not construct a user-controlled shell command.

## Health

A web deployment activates when its configured path returns HTTP 200–399 before the startup timeout. Redirects are not followed. A worker activates after remaining alive through the configured stability window.

## Trust

The flake can execute arbitrary build and runtime code as the Nix Ship OS account. Do not import untrusted repositories. Nix evaluation and the Nix store are not application isolation.
