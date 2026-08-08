{ pkgs }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "npm-start-flake";
  version = "1.0.0";
  src = ./.;

  nativeBuildInputs = [ pkgs.makeWrapper ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/npm-start-flake" "$out/bin"
    cp package.json package-lock.json server.js "$out/lib/npm-start-flake/"

    makeWrapper ${pkgs.nodejs_24}/bin/npm "$out/bin/npm-start-flake" \
      --chdir "$out/lib/npm-start-flake" \
      --add-flags "run start"

    runHook postInstall
  '';
}
