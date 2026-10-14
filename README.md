# Live Activities for the Car Thing

Shows your iPhone's Live Activities on a Spotify Car Thing running [bridgething](https://bridgething.com), full screen
and redrawn natively: timers tick, progress bars move, and changed digits roll the way they do on iOS.

It works through your Mac. macOS 26 mirrors your iPhone's Live Activities into the menu bar; this app reads the same
data macOS receives and sends it to the Car Thing. Nothing is screenshotted or OCR'd.

## Requirements

- A Mac on macOS 26 or later, signed in to the same Apple Account as your iPhone, with iPhone Live Activities showing in
  the menu bar (System Settings > Control Center > Live Activities).
- The bridgething desktop app on that Mac, with the Car Thing connected to it.
- **Full Disk Access for the bridgething desktop app** (System Settings > Privacy & Security > Full Disk Access). macOS
  keeps Live Activity data in protected system containers, and the app's extension runs inside the desktop app, so the
  permission has to be granted to the desktop app itself.

Install **Live Activities** from the bridgething store in the desktop app. When an activity starts on your iPhone, the
Car Thing switches to it; when the last one ends, it goes back to what it was showing. Turn that off with the app's
**Open automatically** setting.

## What the extension can access

The store lists these permissions before you install:

| Permission | Why |
| --- | --- |
| `read:~/Library/Group Containers/group.com.apple.liveactivitiesd` | activity list and each app's content state |
| `read:~/Library/Group Containers/group.com.apple.chronod/chronod/remoteArchives` | the views your iPhone rendered for each activity |
| `read:/System/Library/Fonts`, `read:/Library/Fonts` | system glyphs an archive references but does not embed |
| `net` | App Store icon lookup, and reaching the Car Thing over USB to bring the app forward |
| `sys:homedir`, `sys:networkInterfaces` | finding your home folder and the Car Thing's USB link |

It only reads; it never writes to those folders, and nothing leaves your Mac except to your Car Thing and the
App Store icon lookup.

## How it works

```text
iPhone liveactivitiesd -> IDS / Replicator -> Mac liveactivitiesd -> liveactivitiesd.sql (descriptor, content state)
                                           -> Mac chronod         -> remoteArchives/**.activity-archive
                                                                     (SwiftUI display lists the iPhone rendered)
extension (Deno, in the bridgething desktop app)
  watches both, decodes each archive into SVG -> forward surface -> webapp on the Car Thing
```

- `apps/live-activities/extension/source.ts` reads the activity store and finds each activity's archive.
- `apps/live-activities/extension/archive/` decodes SwiftUI's archived views: the chunk container and manifest, the
  protobuf display list, RenderBox drawing chunks, embedded fonts, images, and content transitions. The format is
  written up in [`docs/archive-format.md`](docs/archive-format.md).
- `apps/live-activities/extension/main.ts` turns changes into snapshots for the Car Thing and brings the app to the
  front when an activity starts.
- `apps/live-activities/src/` is the webapp: the activities' lock-screen views at the screen's width, with timers,
  progress and numeric text animated on the device.

Lock-screen glass is reproduced from measurements: a tinted card shows the app's tint at full saturation over the Car
Thing's black backdrop, and an untinted card is `#131313`, as an iPhone draws them over a black wallpaper.

## Develop

```sh
bun install
bun run --cwd apps/live-activities dev:device   # webapp on the Car Thing, extension under deno with its declared permissions
bun run check                                   # typecheck, build, and validate the catalog, as CI does
bun run render <archive> --tag listItem --png out.png --bg '#000'   # render any archive to svg or png
```

The terminal you develop from needs Full Disk Access, since the dev loop runs the extension as its child.
`tools/fixtures/` (gitignored) is where local test archives go; copy them from the `remoteArchives` folder above.

## Acknowledgements

The display list field numbers were worked out with help from [OpenSwiftUI](https://github.com/OpenSwiftUIProject/OpenSwiftUI)'s
reimplementation of SwiftUI's protobuf encodings.

## License

MIT
