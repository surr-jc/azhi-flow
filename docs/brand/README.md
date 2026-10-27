# Azhi Flow logo

The mark is the Tamil letter ழ (zha), the sound at the heart of ஆழி (aazhi, "sea"), drawn as one
continuous line on a rounded tile. The tail curls under like a wave. It is a custom drawing, not a
font character, so do not retype ழ in a font in its place. The wordmark is Catamaran Bold (SIL Open
Font License), converted to outlines.

| Colour | Hex | Use |
| --- | --- | --- |
| Sea | `#0B6F86` | Tile, "flow" in the wordmark |
| Deep | `#0E2A33` | "azhi" in the wordmark |
| Foam | `#47BED0` | Tile and "flow" on dark backgrounds |
| Night | `#06222B` | Glyph on the Foam tile |

Files: `logo-horizontal` (default), `logo-stacked` (square spaces), `mark` (app icon, avatar),
`glyph` (no tile), `wordmark`, and one-colour versions, each with a `-dark` variant for dark
backgrounds. `icon-512.png` is for places that need a bitmap. In the web app the logo is
`web/src/brand.tsx`, which takes its colours from the theme, and the favicons are in `web/public`.

Leave clear space of a quarter of the mark's height around the logo. Use the mark alone below 96px
of logo width; the mark holds up down to 16px.
