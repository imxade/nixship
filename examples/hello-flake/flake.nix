{
  description = "Minimal Nix Ship web application";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-linux" "x86_64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = import ./live.nix { inherit pkgs; };
        });
      apps = forAllSystems (system: {
        default = { type = "app"; program = "${self.packages.${system}.default}/bin/hello-flake"; };
      });
    };
}
