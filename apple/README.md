# Noteject Apple builds

The iOS target wraps the existing Noteject workspace with Capacitor. It is one universal iOS app for iPhone and iPad; it shares the web workspace and keeps each installation's local browser storage on that device. Cloud accounts continue to use the Noteject service.

## Build from Windows using GitHub Actions

Put the Noteject source in a GitHub repository with Actions enabled. Open **Actions → Apple Apps → Run workflow**. The Mac job builds a universal `.dmg` for Apple Silicon and Intel Macs. Download it from the run's **Artifacts** section.

For an iPhone/iPad build, enable **build_ios**. You can disable **build_mac** when only the iOS app is needed. With **sign_ios** disabled, the hosted Mac compiles an actual arm64 device app and produces `Noteject-iPhone-iPad-<version>-unsigned.ipa`, plus a JSON report with its size and SHA-256. No Apple account is needed for this unsigned compilation on the hosted Mac. The unsigned IPA cannot launch on an ordinary iPhone/iPad until Apple signing and provisioning have been applied. A source archive or prepared web bundle is not an IPA.

On a Mac with Xcode, the same unsigned build can be run with `npm run apple:ipa:unsigned`. The command checks the build platform before starting and does not generate placeholder IPA files on Windows.

To also export an iPhone/iPad `.ipa`, register the devices in your Apple Developer account. Create an Ad Hoc profile for `com.noteject.app` using your Apple Distribution certificate. Add the following under **Settings → Secrets and variables → Actions**, then enable **sign_ios** when running the workflow.

| Secret | Value |
| --- | --- |
| `IOS_CERTIFICATE_P12` | Base64 of the Apple Distribution certificate and private key exported as a `.p12` |
| `IOS_CERTIFICATE_PASSWORD` | Password for the `.p12` |
| `IOS_PROVISIONING_PROFILE` | Base64 of the Ad Hoc `.mobileprovision` file |

The exported IPA can install on devices included in the profile. Only share it with your testers. For the profile and installation steps, see [Apple’s registered-device distribution guide](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices).

The default Mac build uses an ad hoc signature for development. For a Gatekeeper-ready build, enable **notarize_mac** and set `MAC_CERTIFICATE_P12` (base64 Developer ID Application certificate and private key), `MAC_CERTIFICATE_PASSWORD`, `APPLE_API_KEY_P8` (base64 App Store Connect API key file), `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.

## Prepare the native project

On this Windows computer, run:

```powershell
npm run apple:add-ios
```

After the first setup, update the native project with:

```powershell
npm run apple:sync-ios
```

The command generates the hosted web app, then creates or synchronizes the Xcode project in `ios/`.

## Build and install on Apple devices

The generated project is in `ios/App/App.xcodeproj`. On a Mac with Xcode installed, either double-click that project or run this from the full Noteject source checkout:

```sh
npm run apple:open-ios
```

In Xcode, choose an iPhone or iPad simulator, or connect a device. Select the Noteject app target, set the developer signing team, then Build and Run. For distribution, archive the app in Xcode and use the Apple Developer account to sign and distribute it. This Xcode workflow exports and signs the `.ipa` on macOS.

## Build the Mac disk image on Windows

Run `npm ci`, `npm run apple:install-windows-tools`, then `npm run apple:build-mac-windows`. The tools install within `.apple-build/tools`. This path uses verified Electron downloads, a portable Apple signing tool, and a Go HFS+/UDIF writer. It creates separate Apple Silicon and Intel disk images in `release/apple`.

These development packages carry an ad hoc executable signature. Their filesystem, permissions, framework links, and code hashes can be checked on Windows. Launching on macOS and Apple notarization remain separate release checks.

## Build the Mac disk image on macOS

On a Mac with Node.js and the Xcode command line tools, run `npm ci` and `npm run apple:build-mac`. The disk image goes into `release/apple`. To enable notarization locally, set `NOTEJECT_MAC_NOTARIZE=1` with the usual electron-builder Developer ID and Apple API credentials. See [electron-builder’s notarization guide](https://www.electron.build/v26/docs/mac/#notarize).

## iOS signing prerequisites

The existing iOS export workflow uses Xcode. A Windows/WSL path is available through xtool, but the current Xcode project would need a SwiftPM app wrapper. It also requires an official Apple SDK and an Apple account for signing. Those prerequisites are pending in this workspace. See [xtool’s Windows setup](https://github.com/xtool-org/xtool/blob/main/Documentation/xtool.docc/Installation-Linux.md).

The current Windows workspace has no connected macOS runner, Apple SDK, or Apple signing account. Synchronizing `ios/` prepares the app sources and bundled interface; it does not compile the native executable or create a signed IPA. Connect a GitHub repository with Actions (or provide a Mac build machine) to execute the native build. For an installable registered-device IPA, configure the signing secrets described above.
