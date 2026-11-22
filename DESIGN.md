# Design

AM Backup follows **Microsoft Fluent 2** (binding client requirement) through Fluent UI React v9.
It should feel like a first-party Windows 11 utility: calm, familiar, and obvious to office staff.

## Foundations

- **Tokens only.** Colours, radii, shadows, type and motion come from Fluent tokens (`tokens.*`),
  so light and dark themes, high contrast and future Fluent updates work for free. Theme follows
  Windows unless the user picks Light or Dark in Settings.
- **Type:** Segoe UI Variable on Windows (San Francisco on macOS), Fluent's type ramp. One family.
  Tabular numerals (`.tabular`) wherever numbers line up.
- **Surfaces:** canvas `colorNeutralBackground2`; content on `colorNeutralBackground1` with a
  `colorNeutralStroke2` hairline. Panels use `borderRadiusXLarge` and `shadow2`; the status hero
  uses `shadow4`; floating action bars `shadow16`.
- **Brand colour** (`colorBrand*`, Fluent communication blue) is reserved for primary actions,
  selection and "changes that will be undone" on the timeline. Never decoration.

## Patterns

- **Settings rows** (`Group` + `Row`): Windows 11 Settings style — icon, label, description,
  control on the right, optional body underneath. Used for Backup settings and Settings.
- **Option cards** (`OptionCards`): radio groups drawn as cards for choices with consequences
  (backup timing, access level, folder scope, destination, compression). Arrow-key navigation.
- **Choices over typing:** presets, sliders with named steps, dropdowns, toggle chips and folder
  trees replace free text. The only typed fields are names, usernames, passwords, a server address
  and optional custom patterns.
- **Status language:** one plain sentence per engine phase (`components/status.tsx`), always with
  an icon; tone colours use Fluent status tokens (success, warning, danger) and never carry meaning alone.
- **Sticky action bars** for multi-step pages (Restore, unsaved Backup settings).
- **Overlays:** `OverlayDrawer` for editing a user; dialogs only to confirm something destructive
  or to change a password.

## Data visualisation

- Histograms: single series, 4px rounded data ends on the baseline, 2px gaps, recessive dashed
  max line, hover/keyboard tooltip per bar. The restore timeline colours bars after the marker
  (brand) differently from bars before (neutral) and shades the "undo" zone; a legend names both.
- Restore comparison palette (validated for colour-vision deficiency in both modes, always with
  icon + label):

  | Status | Light | Dark |
  |---|---|---|
  | Will be restored | `#107C10` | `#3D9A3D` |
  | Will be replaced | `#0F6CBD` | `#2886DE` |
  | Only in destination | `#C50F1F` | `#D6595D` |
  | Already identical | `#C8C6C4` | `#525252` |

## Motion

Fluent component motion only, plus 150–250 ms transitions on bars and cards. Everything respects
`prefers-reduced-motion`.
