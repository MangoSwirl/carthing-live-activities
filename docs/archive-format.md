# SwiftUI archived view format (majorVersion 13)

What `decode.ts` implements. These field numbers come from the bytes of real archives: ChronoKit `.activity-archive`,
widget `.archive` and `.chrono-timeline` files. OpenSwiftUI only helped with the small leaf types (CGRect,
CGAffineTransform, Color.Resolved, FillStyle). Its DisplayList, Path, image and RenderBox encoders are stubs.

## Container

The file is a series of chunks. Each chunk starts at a 16-byte-aligned offset. The tail of the file holds the chunk
index:

    [offset u64le, length u64le] * count, count u32le, magic u32le 0xd1561a71

You can identify a chunk by its first bytes:

- `{`: JSON.
- `bplist00`: a binary plist.
- `\x89PNG`: a bitmap.
- `0x7a`: a RenderBox attachment.
- `0x0a 0x0a 0x0d`: a view state.

Font chunks start with field 1, which holds the font bytes.

## Manifest and data

The last chunk is the manifest JSON. It has these keys: `dataAttachment`, `stableIDsAttachment`,
`stateAttachments[]` (one chunk index per state) and `majorVersion`.

`dataAttachment` points to the data chunk:

- **Activities** use JSON. It has `viewTags`, plus `viewEntryMetadata[]` with one entry per state. Each entry holds
  `viewTag`, `metrics.bounds = [[0,0],[w,h]]`, `metrics.cornerRadius`, and an optional `listItemViewMetadata`
  `{backgroundTintColor, textColor}` (sRGB 0..1 RGBA). The data also holds `listItem.environment` and
  `dynamicIsland.environment` (plus `dynamicIsland.keyColor` and `widgetURL`). The dynamicIsland environment is shared
  by all four island tags.
- **Widgets** use a bplist. It has `environment`, `viewMetadata[]`, `entryMetadata[]` and `widget`. Widgets have one
  tag. The state size comes from the state chunk itself.

### State order

Take the environment arrays that have more than one value and sort their keys alphabetically. The states of a tag are
the row-major product of those arrays: the last key varies fastest. Any index left after the product is the timeline
entry, which is outermost.

- listItem: `colorScheme[light,dark] x isLuminanceReduced[true,false] x redactionReasons[0,2,1]`.
- dynamicIsland: `isLuminanceReduced x redactionReasons`.
- widgets: `colorScheme x isLuminanceReduced x widgetRenderScheme`.

Two checks confirm this order. Dark states carry a white template tint on the logo image, and light states do not.
Status text is sky-600 in light states and sky-400 in dark states. JSON key order is hash order, so the code does not
use it.

Redaction values: 0 = none, 2 = privacy, 1 = placeholder. Placeholder states replace images with flat colours and text
with bars. For widgets, `widgetRenderScheme {renderingMode.mode 0, backgroundViewPolicy 0}` is full colour with the
widget's own background.

Every state chunk is preceded by small bplists. These are archived modifiers such as WidgetURLModifier
(`{modifier:{url:{relative}}, identity, size}`). Display-list group effects reference them by chunk index.

## State chunk

    1: size {1 w f32, 2 h f32}
    2: DisplayList

### DisplayList and items

    DisplayList { repeated 1 Item }
    Item {
      1 Content { 1 Value, 2 seed }
      2 Effect  { 1 EffectValue, 2 DisplayList }   children
      3 frame CGRect {1 x, 2 y, 3 w, 4 h}           relative to the parent item's origin
      4 identity
      5 states { repeated 1 { 1 hash{1 bytes20}, 2 DisplayList } }   the first state is the resting one
    }

Item order is paint order. An effect applies in the item's local space, after translating to `frame.origin`.

Value, one of:

| field | case |
| --- | --- |
| 1 | color: Color.Resolved `{1 r, 2 g, 3 b, 4 a=1}` in linear extended sRGB. Fills the frame. |
| 2 | image: GraphicsImage. See Images. |
| 3 | shape: `{1 Path, 2 Paint}` |
| 4 | text laid out at display time (date-relative text, placeholders). See Live text. |
| 5 | shadow `{1 Path, 2 {1 color, 2 radius, 3 offset}}`. Draws the blurred, offset shadow of the path only; the shape itself is a separate item. |
| 6 | flattened: `{1 DisplayList, 2 offset, 3 rasterization}` |
| 7 | platform view: `{1 type name, 2 {1 chunk}}`. The chunk is a bplist of the view's archived state. Progress views are drawn from it (see Progress views); other platform views cannot be drawn. |
| 11 | backdrop: `{1 scale, 2 color, 3 filters}` |
| 13 | drawing: `{1 {1 chunk}, 2 offset, 3 rasterization}`. A RenderBox list in an attachment chunk. Draw it at `frame.origin - offset`. All laid-out text arrives this way. |

EffectValue, one of:

| field | case |
| --- | --- |
| 2 | empty group |
| 3 | opacity f32 |
| 4 | blend `{1 CGBlendMode}`. 27 = plusLighter, 26 = plusDarker, 23 = destinationOut. |
| 5 | clip `{1 Path, 2 FillStyle{1 eo, 2 antialias}}` |
| 6 | mask `{1 DisplayList}`, alpha mask |
| 7 | transform CGAffineTransform `{1 a=1, 2 b, 3 c, 4 d=1, 5 tx, 6 ty}` |
| 9 | filter. See Filters. |
| 10 | properties bitset (varint) |
| 12 | platform group `{1 type name, 2 {1 chunk}}`, for example WidgetKit.WidgetURLModifier |
| 14 | accessibility node. The label Text is at `1.1.3.1.2.3.2.1` and the traits at `1.1.3.1.6.1` (256 = static text, 32 = image). |
| 16 | content transition (ContentTransition.State). See Content transitions. |
| 20 | state hash (ignored) |
| 21 | rotation `{1 angle f64 radians, 2 anchor point}` |
| 22 | rotation3d `{1 angle, 2/3/4 axis, 5/6 anchor, 7 anchorZ, 8 perspective}` |
| 25 | accessibility representation. Holds an alternative DisplayList that is not drawn. |

Path (SwiftUI) is one of these fields:

- 1: rect.
- 2: ellipse rect.
- 3: rounded rect `{1 rect, 2 cornerSize, 3 style (1 continuous)}`.
- 4: RenderBox path data.

Paint is one of these fields:

- 1: Color.Resolved.
- 2: linear gradient `{1 Gradient, 2 start UnitPoint, 3 end UnitPoint}`.
- 3: radial gradient `{1 Gradient, 2 center, 3 r0, 4 r1}`.
- 4: angular gradient `{1 Gradient, 2 center, 3 start, 4 end}`.
- 10: linear gradient in absolute points.

`Gradient { repeated 1 stop{1 color, 2 location}, 2 colour space }`.

Filters (inside effect 9) are one of these fields:

- 1: blur `{1 radius}`.
- 2: shadow `{1 color, 2 radius, 3 offset}`.
- 4: 4x5 colour matrix. Fields 1..20, defaults to identity.
- 5: colour multiply.
- 7: saturation f64.
- 8: brightness f64.
- 10: luminance to alpha.
- 14: RGB-only 3x5 matrix.

### Images

    GraphicsImage { 1 contents.color | 2 bitmap {1 chunk} | 3 vector {1 {1 chunk}, 2 size}, 5 scale,
                    6 pixel size, 8 template tint Color.Resolved, 9 ?, 11 ? }

- A bitmap chunk is PNG (or JPEG).
- A vector chunk is a RenderBox list recorded y-up in a `size` box. Flip it and stretch it to the item frame.
- When field 8 is present, the image is a template. Its coverage is painted with the tint. An empty message means
  black.
- Placeholder states use `contents.color` instead of the image.

### Live text

    { 1 { repeated 1 run { 1 utf8 snapshot, 2 attrs }, 4 bplist timer source, 5 paragraph, 7 flags }, 2 layout size }
    attrs { 2 utf16 length, 3 {1 font descriptor chunk}, 4 Color.Resolved (empty = black), 35 bplist format, 34 bplist runs }

- The timer source bplist is `[{countdowns, timerInterval: {start: date, duration: seconds}}]`. It comes from
  `Text(timerInterval:countsDown:)`.
- The format bplist is `[{type, value: {format: {...}}}]`.
  - `type` is a mangled Swift type that names the style, for example `…SystemFormatStyleO5TimerV…`.
  - `format` holds `countingMode.timer.countsdown`, `startDate`, `interval` and `textAlignment.value`
    (0 leading, 1 center, 2 trailing), plus `showsHours`, `monospacedDigits` and the locale.
  - `interval` is a Swift Duration: a 128-bit attosecond count stored as [high, low].
- The text run is the value at archive time. The SVG emits a `<text>` element with the current value and these
  attributes:
  - `data-la-timer-start` and `data-la-timer-end`, in unix ms;
  - `data-la-timer-countdown` ("1" or "0");
  - `data-la-timer-style` (lowercased style name, such as `timer`).
- Timer format: `m:ss` under an hour and `h:mm:ss` above. Countdowns round up and clamp to `[0, duration]`.
  Count-ups round down.

A font descriptor chunk is `{3 postscript name, 4 ?, 5 UI font name (for example CTFontSystemUIRoundedBold or
CTFontDemiUsage), 7 size, 9 bplist JSON of CoreText features, 10 bplist JSON of variations, 12 ?}`.

- Weight is the `wght` axis (key 2003265652) when present. Otherwise it comes from the name.
- Feature type 6 selector 0 means monospaced digits.

The baseline is not encoded. It is placed as `(h - 1.193 size)/2 + 0.952 size`, using the SF Pro line metrics.

### Progress views

`SwiftUI.TimelineProgressView<…ArchivableLinearProgressView…>` is archived as a platform view. Its chunk is
`[{size, view: {interval: [start, end], countdown, resolvedTint: [r,g,b,a] sRGB, updateStyle, extendedState}}]`.

- A countdown fills the remaining share, so the bar shrinks over time. Otherwise it fills the elapsed share.
- Static progress views are expected to carry `fractionCompleted` or `value/total`. No sample confirms this.
- Thickness and track colour are not encoded. iOS draws a 4pt capsule centred in the frame, with a system-fill track
  of rgba(120,120,128,0.25). That track colour was measured on device.
- The fill `<rect>` carries these attributes:
  - `data-la-progress-start` and `data-la-progress-end`, in unix ms;
  - `data-la-progress-countdown`;
  - `data-la-progress-width`, the full width in local SVG units.

### Content transitions

    State { 1 ContentTransition { 1 named, 2 custom {1 method, repeated 2 effect {1 type, 2 arg, ...}}, 3 replaceable },
            2 style {1 sessionWidget | 2 animatedWidget}, 3 animation, 4 options bits (1 drawing group, 2 animates
            different content, 4 forms group, 8 implicit group) }
    named: one field names the transition, plus 8 style.
      2 identity, 3 opacity, 4 interpolate (images and shapes), 5 text {1 different} (the default for Text),
      6 numericText {1 downwards, 2 automatic value, 3 ?}

Activities use the sessionWidget style, and widgets use animatedWidget.

- Transit's minute texts carry the default `text` transition, not an explicit `.numericText`. iOS still rolls their
  digits, so the default text transition in a Live Activity animates per character.
- Explicit numericText appears only in widget archives, for example `{2: 14, 3: 0}`.
- Timer text carries the same `text` transition. iOS does not animate it, because the system ticks it.

The renderer wraps every transition subtree in `<g data-la-transition="identity|opacity|interpolate|text|numericText|custom|unknown|default">`.

Glyph drawings under a `text` or `numericText` transition become:

    <g data-la-numeric="<key>" data-la-text="<string>" [data-la-counts-down="1"] [data-la-value="<n>"]>
      … <g data-la-ch="<char>" data-la-i="<index into data-la-text>"><use …/></g> …
    </g>

- Glyphs with no character, such as a placeholder glyph after an inline image, sit unwrapped.
- Glyphs the cmap cannot name, such as contextual colons and U+202F, take their character from the enclosing
  accessibility label when the label has one character per glyph.
- `<key>` is the nearest ancestor-or-self identity's stable hash from the stableIDs attachment
  `{repeated 1 {1 identity, 2 {1 {1 hash bytes}, 2 serial}}}`, in hex.
  - Several drawings under one hash get `.1`, `.2` and so on.
  - The key survives archive versions: Transit's "Go in 17 minutes" and "Go in 16 minutes" share a key.
  - The key changes when the view is a different view, for example a different route badge.

## RenderBox attachment chunk

    15 resource (repeated) { 1 id, 2 image {1 {1 {1 bitmap chunk}}},
                             3 font {1 {3 {1 chunk}} embedded | {4 {1 chunk}} system font descriptor},
                             4 clip list { repeated 1 {1 {1 Shape, 2 transform}} }, 8 ? }
    4  uuid
    1  List { repeated 1 Entry }
    Entry { 1 Item, 2 group {1 List}, 4 alpha f32, 5 blend, 6 {1 clip resource id}, 7 identity }
    Item  { 1 Shape, 2 Paint, 3 transform }

Shape is one of these fields:

- 1: rect primitive `{1 corner style (4 continuous), 2 rect, 3 radius, 6 stroke width}`. Without a rect it is
  unbounded.
- 2: path `{1 path data, 2 transform, 3 eo}`.
- 3: stroked path `{1 path data, 2 transform, 3 width, 4 cap, 5 join, 6 packed f32 dashes, 7 miter limit}`. Cap and
  join use 0 butt/miter, 1 round, 2 square/bevel. SF Symbol line art arrives this way, for example a clock.
- 5: glyph run `{1 {1 font resource id}, repeated 2 {1 glyph id, 2 x advance in em}, 3 flags, 4 ?}`.

Paint is one of these fields:

- 1: colour `{1 fixed64: four f16 RGBA, sRGB-encoded, 2 colour space (2 = linear), 3 ?}`. An empty message means
  black.
- 2: linear gradient `{1 n*4 f16 colours, 2 f32 locations, 7 start, 8 end}`.
- 3: image `{1 {1 image resource id}, 3 transform, 4 modulating colour {1 f16 RGBA, 3 ?}, 8 ?}`. The transform maps
  the bitmap's unit square (row 0 at y 0) onto the shape, which also clips it. Inline images in text arrive this way,
  for example an emoji drawn from an Apple Color Emoji bitmap, with an alpha-0 placeholder glyph after it.

A glyph run's item transform is `[size, 0, 0, -size, x, baseline]`. Glyph i is drawn at `x_i` em along the run. The
glyph ids index the embedded subset font directly. Clip resources referenced by one entry intersect.

### Path data

    { 2 f32 points, 3 opcode bytes, 4 { repeated 1 transform, repeated 2 stroke style {1 cap, 2 join, 3 packed f32 dashes} } }

The low 7 bits of an opcode are the operation. The high bit means the operation consumes the next field 4 entry.

| op | meaning | floats |
| --- | --- | --- |
| 0 | move | 2 |
| 1 | line | 2 |
| 2 | quad | 4 |
| 3 | cubic | 6 |
| 4 | close | 0 |
| 5 | rect | 4 |
| 7 | ellipse | 4 |
| 8 | rrect, circular corners | 6 (rect, corner size) |
| 9 | rrect, continuous corners | 6 (rect, corner size) |
| 10, 11 | uneven rrect | 8 (rect, then four radii: top-leading, bottom-leading, bottom-trailing, top-trailing) |
| 13 | arc, negative sweep | 5 (cx, cy, r, a0, a1) |
| 14 | arc, positive sweep | 5 (cx, cy, r, a0, a1) |
| 17 | begin transform | 0 |
| 19 | begin stroke | 3 (width, miter, dash phase). Dashes `[0, gap]` with round caps draw dotted lines. |
| 20 | begin union | 0 |
| 21 | next operand | 0 |
| 16 | end group | 0 |

## Fonts

A font chunk is `{1 font bytes, 2 name, repeated 3 {1 original glyph id, 2 subset glyph id}}`. The font bytes are one
of:

- a TrueType subset with `true` magic and the tables cmap/glyf/head/hhea/hmtx/loca/maxp/name/post;
- an sfnt with a CFF table;
- a bare CFF.

TrueType subsets carry a Mac Roman format 6 cmap, so glyphs map back to characters.

System fonts (resource font field 4) are not embedded. They point at a descriptor chunk
`{3 postscript name such as .SFUI-Regular_wdth_opsz110000_GRAD_wght24E0000, 7 size, 10 bplist JSON of axes keyed by
four-char code}`. `sysfont.ts` handles them in three steps:

- It finds the installed macOS file for the family. It looks in /System/Library/Fonts and /Library/Fonts, with
  `.SFUI` aliased to `.SFNS`.
- It instances that font at the archived axes. `sfnt.ts` applies fvar, avar and gvar, including IUP for untouched
  points.
- It accepts the font only if the archive's embedded subsets of the same family agree with it. Each subset's
  original-gid to subset-gid table, read through the subset cmap, must match the installed cmap.

On the Mac used for this work, SFNS is 21.4d2e1 and the iPhone's SF UI is 22.0d5e1. Their glyph ids differ for a
third of the glyphs checked, so no system glyph run resolves there. Apple's own widgets also embed no subsets to check
against. In both cases the run is skipped with a warning.

## Rendering choices

- Text is drawn as glyph outlines taken from the embedded subsets (`<path>` defs plus `<use>`). This is exact and does
  not depend on the browser's font sanitiser or shaping. The text strings are recovered from the cmap. When the cmap
  cannot map a glyph, the code uses the enclosing accessibility label.
- Display-list colours are converted from linear to sRGB. RenderBox colours are already sRGB.
- Activity list items have no background in the display list. `backgroundTintColor` and `textColor` are returned as
  stored for the caller to paint behind the view.
- Open question on the background colour. Focus Friend stores `backgroundTintColor` (0.988, 0.914, 0.804, 1), a cream.
  On the phone the same activity shows (254, 182, 69), a saturated orange with the same hue. The display list
  composites over the orange: the 70% black subtitle measures exactly 0.3 × orange. The cream is about 72% white over
  that orange. So the metadata seems to hold a translucent tint flattened over white, and the phone draws the
  unflattened tint opaquely. The original alpha is not anywhere in the archive, so the decoder cannot reproduce the
  phone's colour.
