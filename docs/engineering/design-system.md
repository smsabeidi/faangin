# Desktop appearance

Faangin's macOS interface follows Apple's [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines), with layered glass surfaces, a neutral dark palette and a light blue accent in light appearance. The design separates interactive chrome from the text people are working with.

## Materials and hierarchy

The sidebar, toolbar, segmented controls, composer, dialogs, and floating overlay use translucent surfaces, background blur, subtle edge highlights, and restrained depth. Answers, transcripts, notes, and code use steadier backgrounds to maintain legibility. This follows Apple's distinction between the functional layer and the content layer in [Materials](https://developer.apple.com/design/human-interface-guidelines/materials).

Electron supplies native macOS vibrancy behind the main workspace. The floating overlay uses a clear native window with one adjustable tint, so actual applications remain visible beneath it. Its toolbar, reading area, and composer share that tint instead of stacking nearly opaque panels. Text and controls remain at full opacity; background opacity ranges from 0% to 100%, with a 35% default for new installations. Existing saved preferences are retained.

The renderer supplies the glass styling of custom controls. These effects approximate the Liquid Glass visual language; they are not AppKit's native `NSGlassEffectView`, and do not reproduce its optical refraction or automatic material merging.

## Color and typography

Dark appearance uses the gray ramp from [Astryx Neutral](https://github.com/facebook/astryx/blob/main/packages/themes/neutral/src/neutralPalettes.generated.ts): `#111111` base, `#1b1b1b` surfaces, `#262626` raised panels, and `#f1f1f1` primary text. Glass, controls, selection, focus, shadows, the floating overlay and dark theme previews use neutral values. Warning and failure states retain their semantic colors and text labels. Only the colors are adopted; no Astryx components, typography, spacing or dependencies are added.

Light appearance follows Apple's [Color](https://developer.apple.com/design/human-interface-guidelines/color) and [Materials](https://developer.apple.com/design/human-interface-guidelines/materials) guidance: neutral content surfaces, clear label hierarchy, restrained accents and material depth in interactive chrome. It uses white content, a soft gray `#f5f5f7` canvas, near-black `#1d1d1f` text, neutral separators/shadows, and blue actions/selection/focus. The blue primary fill is darker than the focus ring so its white label has at least 4.70:1 contrast; faint text on the gray canvas has 4.66:1. These are calculated nominal sRGB token contrasts, not measurements over every translucent background. The palette remains custom semantic CSS, with explicit light/system-light/high-contrast variants; it is not AppKit's dynamic color API. User transparency and native vibrancy remain intact.

The interface uses the macOS system font stack, with a monospace stack for code. The standalone **faangin.** logo uses [Pacifico](https://github.com/google/fonts/tree/main/ofl/pacifico), a connected script chosen as a style match to the user's reference. It is bundled locally at regular weight with normal letter spacing and its SIL Open Font License, so no font service or OS font installation is needed. The separate F monogram is removed. The sidebar wordmark is 30px, reducing to 26px in the narrower sidebar and 14px in the collapsed sidebar; overlays and the empty-state pill use the full wordmark at 20px. The native app icon uses outlines of the same full name on a neutral dark tile. `scripts/wordmark-outline.swift` regenerates that SVG and the transparent, font-independent `public/branding/faangin-wordmark.svg` from the bundled font; `npm run icons` generates the native PNG/ICNS. Small labels and controls follow desktop rather than phone proportions. Text remains selectable and code surfaces support horizontal scrolling.

## Accessibility

Reduce Transparency replaces glass with opaque surfaces and disables native vibrancy. Increase Contrast strengthens text and boundaries. Reduce Motion removes decorative animation and motion transitions. Visible keyboard focus, labels, and icons accompany color-based state changes. The interface retains dark, light, and system appearance choices.

Apple's [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) guidance recommends a 13-point default and 10-point minimum for macOS text, and a 28-point default and 20-point minimum for controls. The desktop styling uses those as its baseline, while preserving the app's reading-size preference.

## Verification scope

The 0.2.8 light workspace and light overlay previews were reviewed in isolated Electron runs. Explicit Light and system-selected light appearance match. All 320 sampled dark workspace properties and 144 dark overlay properties, plus geometry, match the 0.2.7 baseline. Light geometry is unchanged. At very low overlay opacity, contrast depends on the underlying application; text shadows help distinguish text, and solid accessibility modes remain available. macOS preference propagation is implemented; a full VoiceOver audit, system-preference toggle matrix, minimum-window matrix, and hardware display/profile matrix remain separate release checks. See the [build verification record](build-status.md#apple-light-candidate-028) for completed checks.

[Neutral dark workspace](../assets/workspace-dark-preserved-v028.png) · [Apple-inspired light workspace](../assets/workspace-light-apple-v028.png) · [Light overlay](../assets/overlay-light-apple-v028.png) · [Dark overlay](../assets/overlay-dark-preserved-v028.png)
