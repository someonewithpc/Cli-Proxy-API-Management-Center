{
  description = "CLIProxyAPI Management Center, built as a single management.html";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        version = self.shortRev or self.dirtyShortRev or "dev";

        src = pkgs.lib.cleanSourceWith {
          src = ./.;
          filter =
            path: _type:
            !(builtins.elem (baseNameOf path) [
              "node_modules"
              "dist"
              "result"
              ".direnv"
            ]);
        };

        # bun install needs the network, so the dependencies are a fixed-output
        # derivation. Update outputHash whenever bun.lock changes
        nodeModules = pkgs.stdenvNoCC.mkDerivation {
          pname = "cliproxyapi-management-center-node-modules";
          version = "0";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./package.json
              ./bun.lock
            ];
          };
          nativeBuildInputs = [ pkgs.bun ];
          dontConfigure = true;
          dontFixup = true;
          impureEnvVars = pkgs.lib.fetchers.proxyImpureEnvVars;
          buildPhase = ''
            export HOME=$TMPDIR
            bun install --frozen-lockfile --no-progress --ignore-scripts
          '';
          installPhase = ''
            mkdir -p $out
            cp -R node_modules $out/
          '';
          outputHashMode = "recursive";
          outputHashAlgo = "sha256";
          outputHash = "sha256-wgy/OAnrHoRw1s9/Vqdwy9KkrawseDPT6zJmbh/BSFo=";
        };
      in
      {
        packages.default = pkgs.stdenvNoCC.mkDerivation {
          pname = "cliproxyapi-management-center";
          inherit version src;
          nativeBuildInputs = [
            pkgs.bun
            pkgs.nodejs_24
          ];
          configurePhase = ''
            export HOME=$TMPDIR
            cp -R ${nodeModules}/node_modules .
            chmod -R u+w node_modules
            patchShebangs node_modules
            echo ${version} > VERSION
          '';
          buildPhase = ''
            bun run build
          '';
          installPhase = ''
            install -Dm644 dist/index.html $out/management.html
          '';
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.nodejs_24
          ];
        };
      }
    );
}
