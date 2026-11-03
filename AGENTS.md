# AGENTS.md

Instructions for coding agents working in this repository.

## Code style

- Do what you believe is right. Make the change complete and correct, not the smallest possible diff. If a fix calls for refactoring, renaming, or touching multiple files, do it.
- Fix root causes, not symptoms. Do not paper over a defect with catch-and-swallow, degraded fallbacks, or UI workarounds that leave the underlying behavior broken. Trace the failure to where it originates and repair it there — even when that is harder.
- Match the patterns and conventions already in the surrounding code.
- Do not add copyright or license headers unless asked.

## Project layout

| Path | Role |
|------|------|
| `entries/` | Vite multi-page entry points: `main.tsx` (phone), `world-builder.tsx` (3D world builder), `characters.tsx` (standalone character page). Each maps to an HTML file at repo root. |
| `components/` | React UI tree — chat, desktop, settings, check-phone simulated apps, findmy, moments, games, etc. (~6.8 MB, dense codebase; read neighbors before adding). |
| `lib/` | Business logic layer (~268 modules): Dexie/IndexedDB stores, LLM adapter, prompt assembler, engines (chat/group-chat/memory/presence/dwelling/checkphone), importer, backup. |
| `styles/components.css` | Single design-token CSS file shared by all components (`dl-*`, `ap-*`, `fi-*`, `cp-*` families). Reuse existing classes before inventing new ones. |
| `android/` | Capacitor Android project. Native plugins/services live in `android/app/src/main/java/app/floatphone/app/`. |
| `ios/` | Capacitor iOS project (Xcode). No custom native plugins yet — Android-only plugins degrade via the `lib/` wrapper fallbacks (see the dual-platform contract). |
| `custom-apps/` | Built-in user apps installed through the Custom App SDK. |
| `app-store-apps/` | Extra apps for the in-app market. |
| `world-builder/` | 3D world builder page (React Three Fiber). |
| `characters/` | Standalone character management page. |
| `docs/` | Specs and plans (docs/specs/, docs/plans/) plus README screenshots in `docs/screenshots/`. |

User-facing product doc: `README.md` (Chinese-first). The upstream project this repo is built from is `xiaolongbao0709/ai-virtual-phone` — see the README acknowledgement section.

## How the main pieces connect

```text
Vite multi-page build (vite.config.ts)
  index.html / world-builder/index.html / characters/index.html
  → entries/*.tsx → components/* + lib/*
  → out/ → capacitor.config.ts (webDir: out, scheme: https)
  → npx cap sync android → Android WebView shell (MainActivity)

WebView page
  → Capacitor bridge → native plugins (Java/Kotlin under android/app/.../app/floatphone/app/)
  → Dexie/IndexedDB (all app data, per-entity tables)
  → user-configured third-party APIs (LLM / image / voice / music / map tiles)

Static host (Netlify / Cloudflare Pages / Vercel / any server of out/)
  → the same pages in the browser
  → fetch to the user-configured APIs
  → IndexedDB
  → optional directory-handle auto-backup (lib/web-backup-directory.ts)
```

Mental model:

- **Everything is client-side.** There is no project backend. Data lives in IndexedDB (via Dexie stores in `lib/`), app-private native media storage, and localStorage. Supabase-dependent modules from upstream were removed in this branch; direct third-party connectivity (LLM, image gen, music, map tiles) remains.
- **Two shipping shapes share `out/`.** The Android and iOS shells load it through Capacitor. A static host serves the same directory as the website (`netlify.toml`, `vercel.json`, publish directory `out`, domain root). Browser code has to keep working when no native plugin is registered.
- **A feature that must survive screen-off / app-switch** must route through the keep-alive service (`GenerationKeepAliveService` + plugin) and use native HTTP/SSE (`NativeHttpPlugin` via `lib/native-http.ts`) instead of `fetch`, so streaming survives WebView throttling.
- **Large media must not travel over the bridge as base64.** Import/export writes chunks via `Filesystem` (`lib/download-utils.ts`); media blobs are stored natively and referenced as `media-store://<id>` (`NativeMediaPlugin`, `lib/native-media.ts`).

## Platform constraints

- **CORS:** GitHub release assets, some API endpoints, and arbitrary user-hosted files lack CORS headers — WebView `fetch`/`XHR` fails on them even though the network is fine. Inside the Android shell, route such requests through `httpFetch`/`nativeHttp` (OkHttp). A hosted website has no OkHttp: the page calls the user's API with `fetch`, so that API must allow the site origin. An `http://` LAN endpoint fails on an `https` page because of mixed content.
- **Memory:** never accumulate large base64 strings in JS for import/export; the bridge serializes every call. Use the chunked `writeFile`/`appendFile` pattern in `lib/download-utils.ts` (16 MB chunks).
- **Bridge payloads:** Capacitor bridge messages are JSON — sending MB-scale progress/blob data per event floods it. Native plugins emit throttled progress events only; bytes stay native-side.
- **`targetSdk` 35 storage:** public-Documents access requires `MANAGE_EXTERNAL_STORAGE` via `StorageAccessPlugin` → system settings grant → app restart. `lib/storage-access.ts` drives the prompt flow; Android auto-backup and exporters must go through `StorageAccessPlugin.requirePermission()` before touching `/storage/emulated/0/`. Browser auto-backup does not use that plugin. It stores a `FileSystemDirectoryHandle` in `lib/web-backup-directory.ts` and writes the same zip names. Browsers without `showDirectoryPicker` keep the manual export.
- **Self-update:** `lib/app-updater.ts` + `AppUpdaterPlugin` implement check/download/install against GitHub Releases. Downloads are native OkHttp streams with Range-resume; the JS layer is a state machine only. Progress events are only accepted while state is `downloading` (pause-race guard) — keep that invariant when touching it.
- **Version alignment:** `package.json` version, `android/app/build.gradle` `versionName`, and the release tag must agree (`1.0.0` ↔ `v1.0.0`). The updater compares `versionName` against tag names.
- Avoid new third-party dependencies unless strongly justified; prefer existing modules in `lib/` and platform APIs.

## Dual-platform contract (Android + iOS)

The web core (`components/`, `lib/`, `entries/`, `styles/`) is shared and must stay **platform-agnostic**; `android/` and `ios/` are thin native shells that `npx cap sync` feeds the same `out/` build into. Features land for both platforms in one change — never ship an update that only accounts for one platform.

**Rules:**

1. **Every capability must have defined behavior on both platforms** — either a real implementation or a deliberate, documented graceful degradation. "Silently does nothing" or "throws `not implemented`" is not a degradation path.
2. **Platform gates live inside the `lib/` wrapper modules** (`native-http`, `native-media`, `keep-alive`, `storage-access`, `media-permissions`, `app-updater`). Callers stay platform-agnostic; never scatter `getPlatform()` checks through business code, and never call an Android-only plugin unguarded.
3. **Gate with `Capacitor.getPlatform()`, never `Capacitor.isNativePlatform()`** — iOS is also "native", so `isNativePlatform()` is always wrong as an Android check. On iOS an unregistered plugin returns a proxy whose calls reject with "not implemented"; the correct pattern is `getPlatform() === "android"` so iOS falls through to the wrapper's web fallback.
4. **When you touch a plugin contract, update the matrix below** and state the iOS behavior in the PR.

**Capability matrix:**

| Wrapper / plugin | Android | iOS | Hosted website |
|---|---|---|---|
| `native-http` (`NativeHttp`) | OkHttp SSE streaming | `fetch` fallback | `fetch`. The API must allow the site origin |
| `native-media` (`NativeMedia`) | Native disk store, `media-store://` refs | IndexedDB blob fallback | IndexedDB blob fallback |
| `keep-alive` (`GenerationKeepAlive`) | Foreground service + WakeLock | No-op — iOS suspends background tasks; generation requires the app in the foreground | No-op — generation runs while the tab is open |
| `storage-access` (`StorageAccess`) | MANAGE_EXTERNAL_STORAGE → public Documents | Always "granted"; exports live in the app sandbox / share sheet | Unused. Exports use a download or the system share sheet |
| `auto-backup` | Public Documents, keep 3 zips | App Documents via Capacitor Filesystem, keep 3 zips | Directory handle when the browser has one; otherwise manual export |
| `media-permissions` (`MediaPermissions`) | Runtime permission prompts | Always "granted"; iOS prompts are driven by `Info.plist` usage descriptions + WKWebView getUserMedia | Browser permission prompts |
| `app-updater` (`AppUpdater`) | Check/download/install GitHub APK | **Removed** — Apple 2.5.2 forbids in-app binary install; updates ship via App Store/TestFlight | Hidden. The site updates when the host rebuilds |

**iOS hard constraints:**

- No in-app self-update or binary download/install — the About page gates the whole update center to Android (`isAndroidPlatform()`).
- No reliable background execution — keep-alive degrade path is "generation pauses while backgrounded"; do not fake it with silent audio or other review-bait hacks.
- HTTP endpoints: `NSAppTransportSecurity/NSAllowsArbitraryLoads` is set in `ios/App/App/Info.plist` because users configure arbitrary `http://` LLM endpoints (e.g. LAN Ollama).
- WKWebView IndexedDB is evictable under storage pressure — iOS exports/backups are more important, not less. Keep export paths working there.
- Permission prompts come from `Info.plist` usage-description strings (microphone/camera/photo library) — add one when introducing a new protected API.

**Backward compatibility (every update must honor):**

- Dexie schema changes go through `version(n).stores(...)` upgrades — never leave data written by an older release unreadable.
- New `localStorage`/settings keys ship with defaults; importing a backup from an older version must not break.
- Export format changes must keep older exports importable (or provide migration on import).
- Native plugin interface changes keep old call sites working or gate by availability — an APK built on an older web bundle must not crash on a newer native shell, and vice versa.

**Verification:** for changes that touch native code or the wrappers, verify on both platforms — minimum `npx tsc --noEmit` + `npm run build` + `npx cap sync` for `android` and `ios`, plus an honest note in the PR about which platform was device-tested.

## Workflow

- Do not commit secrets, `local.properties`, `android/keystore.properties`, release keystores (`*.jks` and any release `*.keystore`), or IDE/cache junk. The one exception is `android/app/debug.keystore`: a public debug certificate so **Build Android Shell APK** artifacts share a signature and can upgrade each other. Never commit the release key.
- Do not create commits, push, open PRs, or file Issues unless the user asks to deliver / ship / push / open a PR (or equivalent).
- Verify before handing off: `npx tsc --noEmit` (strict; repo should stay at 0 errors), `npm run build`, and `./gradlew assembleDebug` or `assembleRelease` inside `android/` when native code changed. Emulator verification is preferred for bridge-level changes.

### Delivery (Issue + PR + CI)

Default target (Pneuma): [shiaho777/float-android](https://github.com/shiaho777/float-android). Prefer a pull request over direct pushes to `main` when delivering code.

**Language (required):** GitHub **Issues and PRs must be written in English** — titles, bodies, labels text you author, and delivery comments on the Issue/PR. Local chat with the user may be Chinese or any language; do not copy that language into Issue/PR text.

When the user asks to deliver a change, run the Issue → branch → PR → CI → merge loop end-to-end. Do not close the Issue until the PR is merged and CI is green.

**Branch naming:** use plain `type/slug` names — `fix/…`, `feat/…`, `refactor/…`, `docs/…`, `perf/…`, `chore/…`. Do not use tool/agent namespaces (`codex/…`, `devin/…`, etc.); the branch belongs to the repo, not the agent.

PR bodies follow `.github/pull_request_template.md` and must include `Fixes #N` (or `Closes #N`) so the Issue closes on merge — never on PR open, never while checks are red.

### Releases

Releases are GitHub Releases built from `main`:

1. Bump `versionName` in `android/app/build.gradle` and `version` in `package.json` to the new `X.Y.Z`; bump `versionCode` by 1 (Android treats upgrades by `versionCode`; a debug build can replace the previous one only when this number goes up and the debug certificate matches).
2. Build the release APK from that `main` commit (run **Build Android Shell APK** and unzip the artifact, or `npm run build:apk && cd android && ./gradlew assembleRelease`). The file is named `pneuma-android-<versionName>.apk`, from `versionName` in `android/app/build.gradle`. Without `android/keystore.properties` it is signed with the shared `android/app/debug.keystore`; keep every published APK on the same certificate so each release can replace the previous one.
3. Publish the release with the APK attached: `gh release create vX.Y.Z pneuma-android-X.Y.Z.apk --repo shiaho777/float-android --target main --title "Pneuma vX.Y.Z" --notes "…"`. Pneuma ships APKs directly; users download them from Releases. The other shipping path is the static website: hosts serve `out/` (see README).
4. To re-spin the same version, delete and recreate the release and tag at the new commit: `gh release delete vX.Y.Z --cleanup-tag`, rebuild the APK, then the same `gh release create` line.

The in-app updater (设置 → 关于与声明) only lists a release that has an `.apk` asset, so every release must carry one.

iOS distribution is separate: Xcode Archive → TestFlight → App Store. There is no in-app updater on iOS (Apple Guideline 2.5.2); the About page hides the update center there. Keep `ios/` version (`MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`) in step with the same `X.Y.Z` bump when shipping.
