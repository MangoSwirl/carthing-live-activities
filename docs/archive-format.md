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

`renderView` picks full colour by default: `renderingMode.mode 0` above everything, then the colour scheme, no
redaction, `backgroundViewPolicy 0` and full luminance. Accented and vibrant states expect the system to tint them, so
a full-colour state in the other scheme reads better than an accented one in the asked scheme. The widgets
extension's own picker (`extension/main.ts`) uses the same order. The macOS desktop shows the accented (mode 1) states, which explains most of
the colour differences in side-by-side comparisons. The Car Thing target is full colour.

Widgets whose display list has no `WidgetContentLayerTag` background layer (contentLayer 1), or whose state has the
background removed (`backgroundViewPolicy` 1 or 2), are drawn by the system on its own container background. The
renderer paints `WIDGET_BACKGROUND_DARK` (28, 28, 30) or `WIDGET_BACKGROUND_LIGHT` (white) behind them.

Accented (mode 1) and vibrant (mode 2) states are resolved by the widget to light content on a dark host backing in
either colour scheme: Books' light accented state is white text and a 16% white background layer composited with
plus-lighter. They get the dark backing, the dark label colour as default text colour, and in accented mode the
subtrees under `WidgetAccentedDesaturatedViewModifier {accented}` (images marked `widgetAccentedRenderingMode`;
1106 accented, 199 not) are desaturated. The accent colour itself is the user's and not in the archive, so accented
content keeps the neutral tint. The light accented states were white on white before.

The iPhone and Mac digital city clock (`com.apple.mobiletimer.digital.city`) is not a background problem: every state,
including the Mac's full-colour policy 0 ones, draws a white 136 pt face, the tick ring (a rotating angular gradient
masked by the tick image), and explicitly white digits (attribute colour 1, 1, 1). The placeholders have no digits
at all. Something the system applies to this widget is not in the archive.

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
      5 states { repeated 1 { 1 hash{1 bytes20}, 2 DisplayList } }   interactive states; see Interactive controls
    }

Item order is paint order. An effect applies in the item's local space, after translating to `frame.origin`.

Value, one of:

| field | case |
| --- | --- |
| 1 | color: Color.Resolved `{1 r, 2 g, 3 b, 4 a=1, 5 headroom}` in linear extended sRGB. Fills the frame. Field 5 is the HDR headroom (Color.ResolvedHDR); every archive so far says 1, standard range, so it is read and ignored. |
| 2 | image: GraphicsImage. See Images. |
| 3 | shape: `{1 Path, 2 Paint}` |
| 4 | text laid out at display time (date-relative text, placeholders). See Live text. Each run repeats its attributes field 2 as ranges `{1 utf16 location, 2 utf16 length, 3 {1 font chunk}, 4 colour, ...}`; one string can mix fonts, for example Calendar's "8PM" with a small-caps "PM". |
| 5 | shadow `{1 Path, 2 {1 color, 2 radius, 3 offset}}`. Draws the blurred, offset shadow of the path only; the shape itself is a separate item. |
| 6 | flattened: `{1 DisplayList, 2 offset, 3 rasterization}` |
| 7 | platform view: `{1 type name, 2 {1 chunk}}`. The chunk is a bplist of the view's archived state. Progress views are drawn from it (see Progress views); other platform views cannot be drawn. |
| 11 | backdrop (material): `{1 capture scale, 2 tint colour, repeated 3 filter}`. See Materials. |
| 12 | chameleon colour: `{1 Color.Resolved fallback, 2 filters}`. The fallback is drawn. |
| 13 | drawing: `{1 {1 chunk}, 2 offset, 3 rasterization}`. A RenderBox list in an attachment chunk. Draw it at `frame.origin - offset`. All laid-out text arrives this way. |

EffectValue, one of:

| field | case |
| --- | --- |
| 1 | empty group (identity / geometry group; Podcasts placeholders) |
| 2 | empty group |
| 3 | opacity f32 |
| 4 | blend `{1 CGBlendMode}`. 27 = plusLighter, 26 = plusDarker, 23 = destinationOut. |
| 5 | clip `{1 Path, 2 FillStyle{1 eo, 2 antialias}}` |
| 6 | mask `{1 DisplayList}`, alpha mask |
| 7 | transform CGAffineTransform `{1 a=1, 2 b, 3 c, 4 d=1, 5 tx, 6 ty}` |
| 9 | filter. See Filters. |
| 10 | properties bitset (varint): DisplayList.Properties, 1 foreground layer, 2 ignores events, 4 privacy sensitive, 8 archives interactive controls, 16/32/64 secondary/tertiary/quaternary foreground layer, 128 screen capture prohibited. Only accented and vibrant rendering use the layer bits. |
| 12 | archived modifier `{1 type name, 2 {1 chunk}}`. The chunk is a bplist `[{modifier, identity, size}]`. See Interactive controls. |
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

Paint (CodableResolvedPaint) is one of these fields, plus an optional 7:

- 1: Color.Resolved.
- 2: linear gradient `{1 Gradient, 2 start UnitPoint, 3 end UnitPoint}`.
- 3: radial gradient `{1 Gradient, 2 center, 3 r0, 4 r1}`.
- 4: angular gradient `{1 Gradient, 2 center, 3 start, 4 end}`.
- 10: linear gradient in absolute points.
- 7 (alongside the case): anchor rect `{1 x, 2 y, 3 w, 4 h}`. Unit points of a gradient are relative to this rect
  instead of the shape's frame (Photos' memory scrim says the widget's own bounds).

`Gradient { repeated 1 stop{1 color, 2 location}, 2 colour space, 3 headroom (1) }`.

Angular gradients are drawn as a pattern of 180 wedges around the centre, each filled with the colour at its angle
(clockwise from +x; outside [start, end] the end colours hold). Opaque wedges overlap slightly to hide seams.

Filters (inside effect 9) are one of these fields:

- 1: blur `{1 radius}`.
- 2: shadow `{1 color, 2 radius, 3 offset, 4 kind bits, 5 midpoint}`. Kind is ShadowStyle.Kind: 1 inner, 2 only
  (the content itself is not drawn), 4 non-opaque, 8 ignores fill. Game Center's Play button is an inner shadow with
  kind 3 over its green fill. Inner shadows are built from the offset, blurred inverse of the coverage, kept inside
  it. Midpoint is ignored.
- 4: 4x5 colour matrix. Fields 1..20, defaults to identity.
- 5: colour multiply.
- 7: saturation f64.
- 8: brightness f64.
- 10: luminance to alpha.
- 14: RGB-only 3x5 matrix.
- 15: tone curve `{1 packed f32 values at evenly spaced inputs, 2 amount}`, mixed with the identity by amount. Used
  by materials (light: 0.45, 0.55, 0.65, 0.68 at 0.5; dark: 0.24, 0.24, 0.3, 0.39).
- blur also carries 2 and 3 (opaque and dither flags of a material blur), which are ignored.

### Images

    GraphicsImage { 1 contents.color | 2 bitmap {1 chunk} | 3 vector {1 {1 chunk}, 2 size}, 5 scale,
                    6 unrotated pixel size, 7 orientation, 8 mask (template) colour, 9 resizing info,
                    10 isAntialiased, 11 interpolation, 12 allowed dynamic range }

The field order follows OpenSwiftUI's GraphicsImage. Defaults are not written.

- 7 orientation (Image.Orientation, up = 0). Not seen; a non-zero value draws unrotated with a warning.
- 9 resizing `{1 mode (0 stretch, 1 tile), 2 cap insets EdgeInsets {1 top, 2 leading, 3 bottom, 4 trailing}}`. In 396
  archives it is an empty message (stretch, no caps), which is a plain stretch. With caps or tiling and a frame that
  differs from the natural size (pixel size / scale), the renderer draws nine slices: caps keep their size, the middle
  stretches or repeats as a pattern.
- 10 isAntialiased, written as 0 when off (Transit's vector glyphs). An edge-smoothing hint; ignored.
- 11 interpolation: 0 none, 1 low (default), 2 medium, 3 high. 0 is drawn with `image-rendering: pixelated`, which
  keeps QR codes (Instagram's profile QR) crisp when scaled up.
- 12 allowed dynamic range (0 standard). HDR; ignored.

- A bitmap chunk is PNG, JPEG or HEIF. Browsers cannot show HEIF, so the renderer converts it to PNG once with
  macOS `sips` (cached by content hash). Without `sips` the image is skipped with a warning.
- A vector chunk is a RenderBox list recorded y-up in a `size` box. Flip it and stretch it to the item frame.
- When field 8 is present, the image is a template. Its coverage is painted with the tint. An empty message means
  black.
- Placeholder states use `contents.color` instead of the image.

### Live text

Value 4 is `{1 CodableResolvedStyledText, 2 layout size}`. OpenSwiftUI's CodableResolvedStyledText gives the field
numbers of the body:

    body { 1 attributed string { repeated 1 run { 1 utf8 snapshot, 2 attrs } }, 2 style padding EdgeInsets,
           3 layout margins, 4 bplist resolvable configuration (timer source), 5 TextLayoutProperties,
           6 content transitions, 7 features bitset, 8 next size variant (another body) }
    attrs { 1 utf16 location, 2 utf16 length, 3 {1 font descriptor chunk}, 4 Color.Resolved (empty = the scheme's
            label colour), 5 paragraph style, 8 kerning pt, 9 tracking pt, 14 shadow, 15 language,
            18 bplist date format, 20 bplist {wallClock, alignment}, 35 bplist format, 34 bplist runs }
    TextLayoutProperties { 2 line limit (zigzag sint), 3 lower line limit (zigzag), 4 f32 minimum scale factor,
            5 line spacing, 6 line height multiple, 7 maximum line height, 8 minimum line height,
            9 hyphenation factor, 11 pixel length (1/display scale), 12 multiline alignment (1 leading, 2 center,
            3 trailing), 14 ContentTransition.Style {1 sessionWidget | 2 animatedWidget}, 18/19/20 ? }
    paragraph style (NSParagraphStyle) { 1 alignment (CTTextAlignment 0 left, 1 right, 2 center, 3 justified,
            4 natural), 2 line break mode, 3 line break strategy, 4 line spacing, 5 line height multiple,
            6 maximum line height, 7 minimum line height, 8 hyphenation factor, 9/10/12 flags }

How these were identified and what the renderer does:

- **Alignment.** A timer format's `textAlignment` wins, then layout field 12, then the paragraph style's alignment.
  Focus Friend's trailing timer has format alignment 2 and field 12 = 3; Duolingo's centred streak text has 12 = 2.
  Placeholders carry a justified paragraph style (1 = 3). Justified text spreads every line but the last across the
  width at its spaces.
- **Line metrics.** Field 5 is line spacing in points (Notes -8, Help -2, Citrix 10), 6 the line height multiple
  (Photos 0.875, 0.9), 7 and 8 the maximum and minimum line height (Home's tiles: both 14 at 12 pt). The paragraph
  style repeats them (its 4, 5, 6, 7) and the layout properties win. With any of them the line height is
  `clamp(natural x multiple, min, max)`, lines are `lineH + spacing` apart, the count is
  `round((h + spacing) / (lineH + spacing))` capped by the line limit, and the block is centred in the frame. Without
  them the old rule (frame height / natural line height) stands.
- **Lower line limit** (field 3, e.g. `.lineLimit(2, reservesSpace: true)`): the frame already reserves the lines.
- **Hyphenation factor** (9, or the paragraph style's 8; Notes 0.1, Reminders 1, Help 0.2): words still break inside
  only when one alone overflows a line (there is no hyphenation dictionary here), but with a factor above 0 such a
  break ends in a hyphen, as CoreText's does. No real text in the corpus that wraps carries a factor, so this changes
  no current render.
- **Kerning and tracking** (attrs 8 and 9, points): added after every character. Citrix's 16 pt "Citrix Workspace" with
  8 = 0.8 measures 120.9 pt shaped plus 16 x 0.8 = 133.7, and its frame is 134.
- **Shadow** (attrs 14, ShadowStyle `{1 colour, 2 radius, 3 offset}`): News' headline has black at 0.225 with radius
  16. Drawn as a drop shadow under the whole text. The digital clocks carry a near-invisible one (alpha 1/512),
  which is skipped.
- **Style padding** (body 2, EdgeInsets `{1 top, 2 leading, 3 bottom, 4 trailing}`): room for the shadow. The frame is
  the layout size plus the padding, rounded up (News: 128 x 56 text, 22.4 padding, frame 174 x 102 at -23, -23). The
  text box is the layout size, placed at the padding and centred in the rounding remainder. Before this the News
  headline was laid out in the padded frame, over the source logo.
- **Size variants** (body 8): a chain of alternative texts (Podcasts' placeholders: 18, 18 and 10 characters). The
  renderer draws the first whose width fits the frame on the lines it may use, else the last.
- **Features** (body 7): Text.ResolvedProperties.Features bits (4 sensitive, 128 check interpolation strategy, 256
  unique size variant). Not visual. Body 6 repeats the transition the enclosing effect carries.
- **Paragraph style 2, 3, 9, 10, 12.** Line break mode (placeholders say character wrapping, which the bars already
  do), line break strategy (65534 seen) and flags that are constant across the corpus (10 = 0, left to right; 9 and 12
  = 1). They do not move glyphs in left-to-right text.
- **Still unknown:** layout properties 18, 19 and 20 (varint 1; Home tiles and Podcasts placeholders). Candidates
  are the remaining TextLayoutProperties members (truncation mode, writing mode, text sizing, size fitting).

The paragraph's line limit is a zigzag-encoded sint: 2, 4, 6 and 8 are 1 to 4 lines. Across the corpus it agrees with
the line count the frame implies, except where line spacing makes the frame taller, so it caps the line count.
`minimumScaleFactor` (field 4) lets the text shrink before it wraps or truncates. The renderer finds the largest scale
down to that factor at which the text fits its line count, lays out in a box enlarged by 1/scale and draws the result
scaled. Most archived frames were laid out after any shrink, so this rarely triggers.

**Wall-clock text.** `Text(date, style: .time)` and similar time-of-day text carry attrs 20 `{wallClock: true}` and
attrs 18 `{dateFormat: {template: {_0: "Jmm"}}, timeZone: {identifier}, locale: {identifier}}`. The snapshot is the
time at archive time. The renderer formats the current time with the template (J is the locale's hour cycle without
a day period) and emits a `<text>` element in an embedded font subset holding the digits, colon, AM/PM letters and the
snapshot's characters, with:

- `data-la-clock-format`, the template;
- `data-la-clock-tz`, the IANA time zone, when present;
- `data-la-clock-locale`, when present.

A minimum scale factor shrinks live text (timers and clocks) to the width the snapshot string was laid out in.

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

A font descriptor chunk is `{2 {1 font file url}, 3 postscript name, 4 symbolic traits, 5 UI font name (for example
CTFontSystemUIRoundedBold or CTFontDemiUsage), 6 dynamic type size, 7 size, 8 traits, 9 bplist JSON of CoreText
features, 10 bplist JSON of variations, 12 ?, 13 language, 14 ?, 16 text style platform}`.

- 2: the file url of a font the app registered (Duolingo's `file:///var/containers/...`). When that file exists on
  this Mac (Mac apps), the text is shaped with it; iPhone paths never exist and fall through to the usual lookup.
- 6: 3 on every text style, the dynamic type size large. 16: 3 on macOS-rendered widgets (platform 1 and some
  platform-2 apps running on the Mac), 0 on iPhone ones: which platform's text style table resolved the style. Both are
  already folded into the size and weight, so both are ignored.
- 13: the language the font was matched for (`en-Latn-US`). Ignored.
- 8 traits `{2 weight, 3 width, 5 design}`. Width is the CoreText width trait: Font.Width compressed -0.3, condensed
  -0.2, expanded 0.2. It maps to SF's `wdth` axis through the named widths (Compressed 47, Condensed 60, standard 100,
  Expanded 132), linear between them; Photos' compressed memory titles say -0.3 and a 0.1 lands on SemiExpanded, 116.
- 12 (14 on Focus Friend's medium timer, both descriptors that carry it also carry monospaced digits) and 14 (f64
  0.33 on Game Center text, no effect on width or line height) are unknown.
- Feature type 35 (stylistic alternatives) selector 2n turns stylistic set n on: Focus Friend's 35/6 is `ss03`,
  applied through GSUB like `tnum`.

- Weight is the `wght` axis (key 2003265652) when present. Otherwise it comes from the name.
- Feature type 6 selector 0 means monospaced digits.

The baseline is not encoded. It is centred in the layout box using the line metrics of the resolved font (hhea
ascender, descender and line gap), or SF Pro's (`(h - 1.193 size)/2 + 0.952 size`) when no font resolves.

Display-time text has no glyph run, so the renderer shapes it itself with an installed font (`resolveTextFont`):

- **Descriptor features.** Field 9 lists CoreText features. Shaping applies them through GSUB single
  substitutions: (6, 0) is `tnum`, (37, 1) is lower-case small caps `smcp`, and (38, 1) is upper-case small caps
  `c2sc`.
- **Overflow tolerance.** Text only wraps or truncates when it overflows its frame by more than
  `max(1.5 pt, 6% of width)`. The frame is the text's own size rounded up, so smaller differences come from font
  builds and must not cost characters.
- **Condensed text styles.** CoreText resolves `UICTFontTextStyleCondensed*` (for example Stocks' headline,
  CondensedTitle3) to the system font's SemiCondensed instances, `wdth` 80. At other widths the named weights sit at
  other `wght` values (SemiCondensed Semibold is 650, not 590), so the weight is mapped piecewise-linearly from the
  standard-width named instances onto the same-index instances at that width.
- **Descriptor traits.** Field 8 holds `{2 NSFontWeight, 5 design}`. The weight is mapped to `wght` through SF's
  stops: −0.8 → 100, −0.6 → 200, −0.4 → 300, 0 → 400, 0.23 → 510, 0.3 → 590, 0.4 → 700, 0.56 → 860, 0.62 → 1000. A
  design of `NSCTFontUIFontDesignRounded` selects SF Rounded. Example: Reminders' count is `ShortTitle1` with weight
  0.4 and the rounded design, which is SF Rounded Bold 22 pt.
- **Choosing the font.** The descriptor's postscript name picks the face, e.g. `.SFSoftNumeric-Semibold` in
  ADTNumeric.ttc. Without one, the UI font name picks it: CTFont…Usage and UICTFontTextStyle… are the system font,
  and "Rounded" names are SF Rounded. The axes are `wght` (the descriptor's, or SF's value for the named weight:
  semibold 590, medium 510, heavy 860, black 1000) and `opsz` = point size.
- **Shaping.** Characters go through the cmap. Monospaced digits apply `tnum` through GSUB. Advances come from hmtx
  plus the gvar phantom-point deltas. Each glyph gets the size's `trak` value, plus GPOS pair kerning with its GDEF
  variation deltas.
- **Accuracy.** This matches CoreText's line widths to 1e-4 pt on this Mac. The result is drawn as outlines placed by
  the decoded alignment.
- **Line count.** The frame is the text's own laid-out size, so its height gives the visible line count:
  `slots = round(h / natural)`, where `natural` is the hhea line height. The line pitch is `h / slots`. Mac Reminders'
  13 pt body has a 72 pt frame, which is 5 lines at 14.4 pt where natural is 15.3.
- **Line breaking.** Lines break greedily after spaces and hyphens, and inside a word only when the word alone
  overflows. Alignment applies per line.
- **Truncation.** When there are more lines than slots, the last visible line takes all the remaining text. Characters
  (and any spaces before the cut) are then dropped until the line plus "…" (U+2026, shaped in the same font) fits the
  width strictly. This matches macOS. Text the frame was sized for never truncates; the
  overflow tolerance above covers font-build differences.
- **Matching macOS.** On a long title in Mac Reminders' small widget (96 pt wide), this gives the same five lines
  and the same ellipsis point as macOS.
- **Pre-laid-out text.** Glyph-run text arrives with one run per line from the device, so it needs no wrapping.
- **Placeholders.** Redacted text is a run of plane-16 private-use characters (U+100BB7). Single-line placeholder
  frames across the corpus are exactly 0.5 em per character, so the run is laid out as an unbreakable word of 0.5 em
  glyphs and broken across the frame's lines: a two-line title draws a full bar and a shorter one. The bar height
  (0.66 em) was measured from macOS renders.
- **Timers.** They stay `<text>` for the device to rewrite. Their first font-family is an embedded @font-face: a static
  TrueType built from the instanced font (`ttf.ts`), holding the digits, colon and hyphen.

### Materials

Backdrop content (value 11) is a material: everything already drawn behind it, filtered, inside the item's frame,
then the tint colour on top. Every archive so far uses one recipe, in order: tone curve (filter 15), saturation 1.1,
brightness 0.12 (light only), blur 22.5; tint alpha 0; capture scale 0.25 (a resolution hint, ignored).

The renderer keeps, while drawing, what each enclosing display list has drawn so far (and each ancestor item's own
content, and the system widget background), each in its own coordinate space. A backdrop copies all of it into its
local space through the inverse of the current transform, applies the filters, clips to its frame and paints the
tint. Effects between the backdrop and the copied content (opacity, clips) are not reapplied. `data-la-*`
attributes are removed from the copy so only the original animates. Notion's circles, Maps' search pill and Photos'
play button now show the blurred content behind them instead of nothing or a flat fill.

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
      6 numericText {1 downwards, 2 automatic value, 3/4 options (animation only)}
    ContentTransition 4: symbol replace configuration (SF Symbol replace animation), animation only.

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
                             4 clip list { repeated 1 { 1 {1 Shape, 2 transform} | 2 {1 List drawn as an alpha mask},
                                                        4 inverted, 5 identity link } }, 8 ? }
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
- 5: glyph run `{1 {1 font resource id}, repeated 2 {1 glyph id, 2 x advance in em}, 3 flags, 4 placeholder,
  5 ?, 7 {1, 2} dilation}`.
  - 4 = 1 marks a redaction placeholder run: across the corpus every such run uses only the placeholder bar glyphs
    (2650/2672 and 2642/2664 in macOS SF, 2651/2673 in the iPhone's SF UI 22), and no other run is flagged.
  - 7 appears only on runs macOS drew (flags 1085, bit 1024 set) with equal x and y (0.0193 em at 11 pt): a font
    smoothing dilation. Irrelevant to outlines; ignored.
  - 5 is 0 wherever it appears (Home energy placeholders); still unknown.

Paint is one of these fields:

- 1: colour `{1 fixed64: four f16 RGBA, sRGB-encoded, 2 colour space (2 = linear), 3 headroom (1)}`. An empty
  message means black.
- 2: linear gradient `{1 n*4 f16 colours, 2 f32 locations, 6 colour space (2 = linear, as for colours), 7 start,
  8 end, 14 ?}`. Life360's battery gradient says 6 = 2 and is converted like a linear colour. 14 = 1 (Screen Time and
  Weather placeholders) is unknown.
- 3: image `{1 {1 image resource id}, 3 transform, 4 modulating colour {1 f16 RGBA, 3 headroom}, 8 ?}`. 8 is always 11
  (Notes, Translate) and unknown. The transform maps
  the bitmap's unit square (row 0 at y 0) onto the shape, which also clips it. Inline images in text arrive this way,
  for example an emoji drawn from an Apple Color Emoji bitmap, with an alpha-0 placeholder glyph after it.

Glyph ids normally index the embedded subset. CoreGraphics leaves glyphs it did not subset under their original
ids, and runs then mix the two: Fitness' "25/30MIN" has `[18 (subset '2'), 1252 (original '5')]` and its unit run
`[168, 115, 172]` points at a 3-glyph subset. An id at or past the subset's glyph count is resolved through any
same-family subset whose map has that original id, else through the installed family font when the archive's
subsets verify its ids (SFNSRounded matches the iPhone's SF UI Rounded 22 there). The digit and the units were
blank before ("2  /30").

A glyph run's item transform is `[size, 0, 0, -size, x, baseline]`. Glyph i is drawn at `x_i` em along the run. The
glyph ids index the embedded subset font directly. Clip resources referenced by one entry intersect.

A clip entry is either a shape or a display list used as an alpha mask (Weather's sunrise curve masks its lower half
with white rect primitives). Field 4 = 1 inverts it: only what lies outside the clip is kept. SF Symbols use inverted
clips to cut gaps, for example the space between the Podcasts symbol's head and its rings.

Unverifiable system fonts (see Fonts) are drawn two ways rather than dropped:

- A placeholder run (field 4, or a run made only of glyph ids that flagged runs of the same font resource use) is one
  rounded bar with the geometry of SF's placeholder glyph U+100BB7: 0.705 em tall from the baseline, 0.488 em per
  segment from the first glyph to the end of the last, corners 0.144 em. Screen Time's and Contacts' iPhone
  placeholders were blank before.
- A run under an accessibility label with one character per glyph is drawn from the label's characters in the
  installed family, instanced at the archived axes, at the archived x positions (Game Center's "Activity").

Unknown in RenderBox lists: shape path 4, rect 8 and glyph run 5 (always an explicit 0, on the same Home energy,
Weather and Screen Time placeholders) and chunk 5 (1). An explicit 0 next to a default-true flag (like SwiftUI's
isAntialiased) is the likeliest reading, but nothing in the corpus tells them apart from the drawn result.

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
- a bare CFF;
- a PostScript Type 1 font (`%!FontType1-1.0`, binary eexec section). CoreGraphics embeds fonts it cannot subset as
  CFF or TrueType this way, for example PingFang for Chinese text. `type1.ts` decrypts the private dictionary
  (eexec r=55665, charstrings r=4330 with lenIV) and runs Type 1 charstrings, including flex and hint replacement
  through `callothersubr`. Glyph names are `gid<original id>`; field 3 maps the original ids to the ids the glyph runs
  use, which also follow the subset's encoding order (code + 1).

TrueType subsets carry a Mac Roman format 6 cmap, so glyphs map back to characters.

System fonts (resource font field 4) are not embedded. They point at a descriptor chunk
`{3 postscript name such as .SFUI-Regular_wdth_opsz110000_GRAD_wght24E0000, 7 size, 10 bplist JSON of axes keyed by
four-char code}`. `sysfont.ts` handles them in three steps:

- It finds the installed macOS file for the family. It looks in /System/Library/Fonts and /Library/Fonts, with
  `.SFUI` aliased to `.SFNS`.
- It instances that font at the archived axes. `sfnt.ts` applies fvar, avar and gvar, including IUP for untouched
  points.
- When the descriptor names a PostScript name that is one of the face's fvar named instances (for example
  `.SFSoftNumeric-CompressedSemibold`), that instance's coordinates pin every axis, so width and grade are right.
- It accepts the font only if the archive's embedded subsets of the same family agree with it. Each subset's
  original-gid to subset-gid table, read through the subset cmap, must match the installed cmap.
- Archives drawn on this Mac skip that check, because the installed fonts are the ones they used.
  - A Mac archive has `extensionBundle.identifier.deviceIdentifier.local`, and either `systemVersion.platform == 1`
    or an extension URL inside `.app/Contents/`.
  - The URL test matters because iOS-platform widgets running on the Mac, such as Stocks, report platform 2.
  - `deviceIdentifier.local` alone is not enough, because iPhone archives carry it too.
  - `readArchive(bytes, { local })` overrides the detection.

On the Mac used for this work, SFNS is 21.4d2e1 and the iPhone's SF UI is 22.0d5e1. Their glyph ids differ for a
third of the glyphs checked, so no system glyph run resolves there. Apple's own widgets also embed no subsets to check
against. In both cases the run is skipped with a warning.

## Interactive controls

An item's `5 states` list holds one display list per interaction state. Each state is keyed by a StrongHash, which is
the SHA-1 of the state value's bytes:

- **Buttons and links** have a pressed flag, one byte. SHA-1(00) = `5ba93c9d…` is resting, and SHA-1(01) =
  `bf8b4530…` is pressed (dimmed or scaled). The pressed state comes first, so drawing the first state showed every
  button and link pressed.
- **App Intent toggles** use the toggle value as int64 little-endian:
  - SHA-1 of 0 = `05fe4057…`, the on (completed) appearance;
  - SHA-1 of 1 = `3da89ee2…`, off;
  - SHA-1 of 2 = `b0aa4b54…`, a second off appearance.

  The current value is in the enclosing ArchivableToggleAppIntentModifier's `toggleState.value`.

The resting state is chosen in this order:

1. the nearest enclosing toggle's value hash;
2. not pressed;
3. the first state, with a warning.

Archived modifiers (effect 12) point at bplists `[{modifier, identity {value}, size}]`. The renderer reports each
control as `controls[]`: the rect is the modifier item's frame mapped through every enclosing transform into SVG units.

| modifier | `modifier` payload | control |
| --- | --- | --- |
| SwiftUI.ArchivableToggleAppIntentModifier | `{toggleState {value, appIntentAction {lnAction}}, isEnabled}` | toggle; `isOn` = value 0 |
| SwiftUI.ArchivableButtonAppIntentModifier | `{action {lnAction}, isEnabled}` | button |
| SwiftUI.ArchivableLinkModifier | `{configuration {url {relative}, isSensitive}}` | link |
| WidgetKit.WidgetURLModifier | `{url {relative}}` (whole-widget tap target) | link |
| SwiftUI.ArchivableAccessibilityViewModifier | `{attachment {actions [{kind {custom}, intent {lnAction}}]}}` | not reported; accessibility custom actions such as "Mark as Completed" |
| others (WidgetContentLayerTag, InvalidatableContentModifier, HideViewInCarPlayModifier, WidgetAccentedDesaturatedViewModifier) | layout or rendering flags | none |

### Clock hands

`WidgetKit._ClockHandRotationEffect` is an archived modifier with payload
`{anchor [x, y] unit point, period seconds (43200 hour, 3600 minute, 60 second), timeZone {identifier}}`.

- The hands are archived pointing at 12. The system turns the subtree continuously, clockwise, with wall-clock time
  in that zone.
- The renderer wraps the subtree in `<g data-la-rotate-period data-la-rotate-epoch data-la-rotate-cx
  data-la-rotate-cy transform="rotate(…)">`, carrying no other transform. The initial transform is the angle for
  `now`.
  - `epoch` is the most recent local midnight in the zone, as unix ms. The angle is
    `((now - epoch) / (period * 1000) * 360) mod 360`.
  - The centre is `anchor * frame size`, in the group's local units.
- The neighbouring effect 20 is the state hash (the same SHA-1 scheme as interactive states). It carries no rotation.
- The iPhone World Clock placeholders have no rotation effect; they are static.

### LNAction encoding

`lnAction` is an NSKeyedArchiver bplist of an LNAction (`keyed.ts` resolves the uid graph into JSON). An LNAction is:

    { identifier: intent type name, mangledTypeName, openAppWhenRun, systemProtocols,
      parameters: [LNProperty { identifier, value: LNValue { valueType, value, displayRepresentation } }],
      metadata: LNActionMetadata { effectiveBundleIdentifiers: [LNEffectiveBundleIdentifier { bundleIdentifier, url }],
                                   parameters: [LNActionParameterMetadata { name, title, valueType, ... }], ... } }

- An entity parameter is `LNEntity { identifier: LNEntityIdentifier { typeIdentifier, instanceIdentifier } }`. The
  display title is in `displayRepresentation.title.defaultValue`.
- Primitive values (bool, string, number) are stored directly. App enums arrive as their raw string, for example
  `direction: "down"`.
- `controls[].action` carries `raw` (base64 of the archive) and `decoded`:
  `{ identifier, mangledTypeName, bundleIdentifier, openAppWhenRun, parameters: [{ identifier, value }] }`.
  - Entity values are decoded as `{ entity, id, title }`.
  - Example (Reminders): `TTRReminderSetCompletedIntent`, `reminder = { TTRReminderAppEntity,
    x-apple-reminderkit://REMCDReminder/<uuid>, "Buy milk" }`, `isCompleted = true`. The archived action is the one
    the toggle performs when tapped.
- Nothing is executed.

## Unknown data

`readArchive(...).unknowns` and `renderView(...).unknowns` list what the decoder saw but could not interpret, as
`{ code, detail?, count }`, most frequent first.

Every protobuf message tracks which fields an accessor read. After decoding a typed message, the fields nobody read
are reported against the message's role. Codes are stable:

| code | meaning |
| --- | --- |
| `effect-field:N` | an effect case we do not know. Known no-ops are not reported: 2 empty group, 10 properties, 20 state hash, 25 accessibility representation. |
| `content-field:N`, `filter-field:N`, `paint-field:N`, `transition-field:N`, `rb-shape-field:N`, `rb-paint-field:N` | an unknown case of that oneof |
| `unread:<Role>.<N>` | field N present in a known message (Item, Text, TextAttributes, FontDescriptor, RBEntry, Path, ...) but never read |
| `bplist-key:<path>.<key>` | a manifest, data or modifier key we do not know (manifest `encoding`, always 0, is known) |
| `modifier-type:<Name>` | an archived modifier type we do not know |

`tools/coverage.ts` lists files the OS refuses to open (some Find My containers stay protected even with Full Disk
Access) in their own section, not as decoder errors.

`detail` is a short preview: the varint, the float, or the first bytes in hex. Fields that are known and deliberately
unused are whitelisted in code with the reason, for example content seeds and rasterization options. Warnings remain
for things that are known but drawn approximately or not at all.

## Rendering choices

- Text is drawn as glyph outlines taken from the embedded subsets (`<path>` defs plus `<use>`). This is exact and does
  not depend on the browser's font sanitiser or shaping. The text strings are recovered from the cmap. When the cmap
  cannot map a glyph, the code uses the enclosing accessibility label.
- Display-list colours are converted from linear to sRGB. RenderBox colours are already sRGB.
- Filters use a user-space region around the item's frame, padded for blur and offset. A bounding-box region collapses
  to nothing on zero-width content such as a clock hand.
- Within a RenderBox list and among display-list siblings, blend 17 (copy), 18 (source-in) and 23 (destination-out)
  rewrite what is already drawn. For copy and destination-out everything so far is masked by the entry's coverage,
  then copy draws the source with its own alpha. Source-in draws the source only where the destination has coverage
  and drops the destination.
  - SF Symbols use copy with an alpha-0 colour to cut gaps, as in Books' open-book glyph.
- An image paint with a modulating colour (field 4) is a template: the bitmap's coverage is flooded with that colour.
- Live text subsets declare their instanced weight in `@font-face`, so browsers do not embolden them synthetically
  when the `<text>` asks for a bold weight.
- Archived platform views have no content in the archive. The renderer marks the space with iOS's translucent
  tertiary system fill (118, 118, 128, 0.24), the redaction placeholder colour, over the widget's own background.
  Batteries' BatteryCenterUI.BatteryAvocadoArchivableView is archived as `{view: {}, size}` in every timeline,
  placeholder and snapshot, and no chunk holds a bitmap or battery data, so nothing more can be drawn; it was an
  opaque dark block in both colour schemes before.
- Activity list items have no background in the display list. `backgroundTintColor` and `textColor` are returned as
  stored for the caller to paint behind the view.
- Open question on the background colour. Focus Friend stores `backgroundTintColor` (0.988, 0.914, 0.804, 1), a cream.
  On the phone the same activity shows (254, 182, 69), a saturated orange with the same hue. The display list
  composites over the orange: the 70% black subtitle measures exactly 0.3 × orange. The cream is about 72% white over
  that orange. So the metadata seems to hold a translucent tint flattened over white, and the phone draws the
  unflattened tint opaquely. The original alpha is not anywhere in the archive, so the decoder cannot reproduce the
  phone's colour.
