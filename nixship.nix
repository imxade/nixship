{
  pkgs,
  self,
  systems,
}:
let
  pnpmDeps = pkgs.fetchPnpmDeps {
    pname = "nixship";
    version = "0.1.0";
    src = self;
    pnpm = pkgs.pnpm_10;
    hash = "sha256-bO8zeV9r1A/Fmy9Inwfhb28PeVyrJLCFQ+OHMzlLInE=";
    fetcherVersion = 3;
  };
in
pkgs.stdenv.mkDerivation {
  pname = "nixship";
  version = "0.1.0";
  src = self;
  nativeBuildInputs = [
    pkgs.nodejs_24
    pkgs.pnpm_10
    pkgs.pnpmConfigHook
    pkgs.python3
    pkgs.pkg-config
  ];
  inherit pnpmDeps;
  buildPhase = ''
    runHook preBuild
    pnpm build
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/nixship $out/bin
    cp -R .next public migrations dist-server src scripts package.json pnpm-lock.yaml node_modules $out/lib/nixship/
    cat > $out/bin/nixship <<WRAPPER
    #!${pkgs.runtimeShell}
    set -euo pipefail
    cd $out/lib/nixship
    export NODE_ENV=production
    export HOSTNAME="\''${HOSTNAME:-0.0.0.0}"
    export PORT="\''${PORT:-3000}"
    export PATH="${pkgs.lib.makeBinPath [
      pkgs.nix
      pkgs.git
      pkgs.cloudflared
      pkgs.gnutar
    ]}:\$PATH"
    exec ${pkgs.nodejs_24}/bin/node dist-server/server.js
    WRAPPER
    cat > $out/bin/nixship-backup <<WRAPPER
    #!${pkgs.runtimeShell}
    set -euo pipefail
    cd $out/lib/nixship
    export PATH="${pkgs.lib.makeBinPath [ pkgs.gnutar ]}:\$PATH"
    exec ${pkgs.nodejs_24}/bin/node node_modules/tsx/dist/cli.mjs scripts/backup.ts "\$@"
    WRAPPER
    cat > $out/bin/nixship-restore <<WRAPPER
    #!${pkgs.runtimeShell}
    set -euo pipefail
    cd $out/lib/nixship
    export PATH="${pkgs.lib.makeBinPath [ pkgs.gnutar ]}:\$PATH"
    exec ${pkgs.nodejs_24}/bin/node node_modules/tsx/dist/cli.mjs scripts/restore.ts "\$@"
    WRAPPER
    chmod +x $out/bin/nixship $out/bin/nixship-backup $out/bin/nixship-restore
    ln -s nixship-backup $out/bin/platform-backup
    runHook postInstall
  '';
  doCheck = true;
  checkPhase = ''
    pnpm typecheck
    pnpm test
  '';
  meta = {
    description = "Next.js control plane for trusted Nix flake deployments";
    license = pkgs.lib.licenses.asl20;
    platforms = systems;
    mainProgram = "nixship";
  };
}
