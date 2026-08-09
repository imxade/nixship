{
  description = "Minimal npm run start application for Nix Ship";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.stdenvNoCC.mkDerivation {
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
          };
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/npm-start-flake";
        };
      });
    };
}
