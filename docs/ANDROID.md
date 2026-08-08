# Android and Nix-on-Droid

## What works

On a supported 64-bit ARM Android device, Nix-on-Droid can provide Nix, Node.js, Git and cloudflared in user space. Nix Ship can run as a LAN web service and supervise compatible `aarch64-linux` flake applications.

## What it is not

- not NixOS;
- not a VM;
- not Docker;
- not a kernel or permission escape;
- not safe multi-tenant hosting;
- not an uptime-guaranteed VPS.

## Android lifecycle constraints

- Acquire the Nix-on-Droid/Termux wake lock while hosting.
- Exempt the application from battery optimization where the device permits.
- OEM task killers may still stop it.
- Android Force stop cannot be automatically recovered until the user opens the app again.
- Memory-intensive Nix builds may be killed.
- Reboot restoration requires Nix-on-Droid boot integration or a future native Android foreground-service wrapper.

## Initial installation approach

1. Install a trusted current Nix-on-Droid build.
2. Complete its Nix bootstrap.
3. Clone this repository and enter its locked `nix develop` shell.
4. Run `scripts/android/run-nix-on-droid.sh verify` to validate the package and capture evidence.
5. Start Nix Ship with a wake lock. The test-only `serve-ci` mode is loopback-only and exists solely for Maestro acceptance.
6. Open the displayed LAN address from another device.
7. From the controller, enter `nix develop .#android`; this locked shell supplies
   Maestro, ADB, Java, curl, and yq.
8. Run `scripts/android/run-maestro.sh first-run-setup physical` with the complete
   printed `SETUP_URL`, `OWNER_USERNAME`, and `OWNER_PASSWORD` environment values.
9. Test screen-off, network switching, control-plane restart and reboot and
   retain the generated `artifacts/android/` evidence.

For UI development only, `scripts/android/run-maestro.sh ci-login
development-emulator` may target an emulator and a controller-hosted Nix Ship
origin. Its evidence is marked `release_evidence=false`. The default `physical`
mode requires an attached physical ARM64 device and remains the only mode that
can contribute to Android release evidence.

## Production Android direction

- Fork the official Nix-on-Droid repository.
- Install dependencies using the Nix-on-Droid shell.
- Create the `.env` and other configuration files required by the project.
- Add a persistent Android foreground service with a notification that keeps
  the Nix Ship control plane running.
- Replace the default launcher UI with a WebView that directly displays the
  Nix Ship web interface.
- Open the generated one-time setup URL in the WebView during initial account
  creation. The URL establishes the claim cookie; no token field or manual
  copy-paste step exists.

The Next.js control plane remains unchanged and is started by this native lifecycle wrapper.

The native wrapper, APK project, signing material, packaged binaries and release channels will live in a separate Android distribution repository. This repository owns the control plane, Nix-on-Droid validation scripts, Maestro browser flows and network contract only; it does not produce or ship an APK.
