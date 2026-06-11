# Home Manager module for CloseScreen
# Usage in flake-based Home Manager config:
#
#   inputs.closescreen.url = "github:pjyqifei02/CloseScreen";
#
#   { inputs, ... }: {
#     imports = [ inputs.closescreen.homeManagerModules.default ];
#     programs.closescreen.enable = true;
#   }
self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.closescreen;
in
{
  options.programs.closescreen = {
    enable = lib.mkEnableOption "CloseScreen screen recorder";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.closescreen;
      defaultText = lib.literalExpression "inputs.closescreen.packages.\${pkgs.stdenv.hostPlatform.system}.closescreen";
      description = "The CloseScreen package to use.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
