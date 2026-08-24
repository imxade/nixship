{
  description = "Nix Ship — Next.js control plane for Nix flake applications";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-linux" "x86_64-linux" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          basePackages = with pkgs; [
            nodejs_24
            pnpm_10
            git
            cloudflared
            python3
            pkg-config
            sqlite
            gnutar
          ];
          mkNixShipShell = {
            packages,
            label ? "development",
            extraShellHook ? "",
          }: pkgs.mkShell {
            inherit packages;
            shellHook = ''
              export PLATFORM_DATA_DIR="''${PLATFORM_DATA_DIR:-$PWD/.local-data}"
              echo "Nix Ship ${label} shell (${system})"
              echo "Run: pnpm install && pnpm dev"
              ${extraShellHook}
            '';
          };
        in {
          default = mkNixShipShell { packages = basePackages; };
          ai = mkNixShipShell {
            label = "AI development";
            packages = basePackages ++ (with pkgs; [
              curl
              ollama
            ]);
            extraShellHook = ''
              export OLLAMA_HOST="''${OLLAMA_HOST:-127.0.0.1:11434}"
              export OLLAMA_MODELS="''${OLLAMA_MODELS:-$PLATFORM_DATA_DIR/ai/ollama/models}"
              export PLATFORM_AI_BASE_URL="''${PLATFORM_AI_BASE_URL:-http://127.0.0.1:11434/v1}"
              export PLATFORM_AI_ALLOW_PRIVATE_NETWORK="''${PLATFORM_AI_ALLOW_PRIVATE_NETWORK:-true}"
              export AI_LOCAL_TEST_BASE_URL="''${AI_LOCAL_TEST_BASE_URL:-http://127.0.0.1:11434/v1}"
              echo "Ollama is pinned by flake.lock and configured for 127.0.0.1:11434"
              echo "Start it in another AI shell with: ollama serve"
            '';
          };
          android = mkNixShipShell {
            label = "Android development";
            packages = basePackages ++ (with pkgs; [
              android-tools
              curl
              jdk21_headless
              maestro
              yq-go
            ]);
          };
        });

      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in {
          default = import ./nixship.nix {
            inherit pkgs self systems;
          };
          ollama = pkgs.ollama;
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/nixship";
        };
      });
    };
}
