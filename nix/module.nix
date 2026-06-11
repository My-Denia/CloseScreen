# NixOS module for CloseScreen
# Usage in flake-based NixOS config:
#
#   inputs.closescreen.url = "github:pjyqifei02/CloseScreen";
#
#   { inputs, ... }: {
#     imports = [ inputs.closescreen.nixosModules.default ];
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
    environment.systemPackages = [ cfg.package ];

    # Screen capture on Wayland requires xdg-desktop-portal.
    # We enable the base portal; users should also enable a
    # desktop-specific portal (e.g. xdg-desktop-portal-gtk,
    # xdg-desktop-portal-hyprland) in their DE config.
    xdg.portal.enable = lib.mkDefault true;
  };
}
