---
name: Lodestar Loader
description: Native Windows operator console for recorded Lodestar state
colors:
  mint-action: "#5CE0C0"
  mint-focus: "#8FE8D3"
  graphite-canvas: "#11161F"
  graphite-pane: "#141B26"
  graphite-chrome: "#1B2330"
  graphite-line: "#2A3543"
  graphite-hover: "#263446"
  graphite-selection: "#244940"
  ink: "#E7EDF4"
  muted-ink: "#AAB9CA"
typography:
  body:
    fontFamily: "Segoe UI"
  code:
    fontFamily: "Cascadia Code, Consolas"
components:
  button-default:
    backgroundColor: "{colors.graphite-chrome}"
    textColor: "{colors.ink}"
  navigation-active:
    backgroundColor: "{colors.graphite-selection}"
    textColor: "{colors.ink}"
  input-default:
    backgroundColor: "{colors.graphite-chrome}"
    textColor: "{colors.ink}"
  table-row-selected:
    backgroundColor: "{colors.graphite-selection}"
    textColor: "{colors.ink}"
---

# Design System: Lodestar Loader

## Overview

**Creative North Star: "Lodestar Workstation"**

This is the built native WPF operator console: a dense graphite workspace for observing Lodestar records, inspecting their provenance, and deliberately reviewing corrections. The restrained mint accent identifies action, selected navigation, recorded status, and focus. Text, tables, and source times carry the information; the interface does not imply a universal project status or turn an unchecked store into a healthy one.

**Key Characteristics:**

- Three working zones at wide sizes: project rail, main workspace, contextual inspector.
- Compact rows, hairline boundaries, text labels, and quiet alternating table surfaces.
- Readable record sections first, with exact raw/history evidence and guarded editing nearby.
- Windows keyboard, splitter, scrolling, and high contrast behavior remain native.

## Colors

The default theme uses dark graphite surfaces and one mint accent. The frontmatter records the exact default WPF brush colors; high contrast replaces them at runtime with Windows system brushes.

### Primary

- **Mint action** (`mint-action`): brand wordmark, active navigation edge, selected tab underline, readout status, group headings, and type hints.
- **Mint focus** (`mint-focus`): keyboard focus border on controls and rows; it is lighter than the action accent.

### Neutral

- **Graphite canvas** (`graphite-canvas`): main client background.
- **Graphite pane** (`graphite-pane`): data, inspector, and readout surfaces.
- **Graphite chrome** (`graphite-chrome`): command/status bars, navigation rail, inputs, headers, and alternating rows. `InkSoft` and `Input` are separate WPF resource keys with this same value.
- **Graphite line** (`graphite-line`): table rules, borders, pane dividers, and splitter tracks.
- **Graphite hover** (`graphite-hover`): pointer hover on buttons and selectable rows.
- **Graphite selection** (`graphite-selection`): selected and pressed surfaces; selection also has an explicit label or border cue where implemented.
- **Ink** (`ink`) and **muted ink** (`muted-ink`): primary text versus source details, captions, timestamps, and supporting text.

**The Observed State Rule.** Health uses text such as “Not checked” and “unknown” until the operator explicitly runs the public Lodestar doctor read. Color never supplies a missing fact.

## Typography

Segoe UI is the window and control face. The window base is 12 device-independent pixels (DIP); the main title is 20 DIP semibold and the inspector title is 18 DIP semibold. Ten DIP text is reserved for secondary row details, source captions, and type hints. Table headers and key labels use semibold weight. Advanced editable JSON alone uses Cascadia Code with Consolas fallback at 11 DIP; the raw/history readout inherits the normal interface face.

Labels remain visible beside values and timestamps. The narrow rail truncates long secondary text, while descriptions, provenance, and readable record values wrap in the inspector.

## Layout

The window starts at 1440 × 900 DIP and has a 900 × 600 DIP minimum. A 44 DIP command bar and 24 DIP status bar frame the main area. The left rail starts at 190 DIP and can be resized from 160 to 280 DIP with a 5 DIP splitter. The main workspace fills the rest, with an 11 × 10 DIP outer margin. The inspector appears for selected content, starts from a preferred 360 DIP width, and resizes from 300 to 600 DIP through another 5 DIP splitter. “Collapse” and “Reset width” expose the same sizing controls without dragging.

At an actual window width below 1180 DIP, the inspector replaces the main workspace when opened and shows Back; the rail remains. Returning preserves the draft under the code's navigation guard. This is a WPF window-width threshold in DIP, not a CSS breakpoint or a screenshot-pixel threshold. Main controls wrap where the XAML uses `WrapPanel`; the project rail and tables retain scrolling at the 900 × 600 DIP minimum.

Health is the default workspace: observations table, issues/actions, then recent recorded activity. Project and record views use column tables with sorting and grouping controls; the project rail has a finder, sort, history toggle, and compact project rows. These are read-only browsing surfaces, with the contextual inspector carrying reading and editing.

**The Pane Rule.** A selected record earns an inspector; an empty selection leaves the main workspace full width. At compact width, one content pane occupies that area at a time.

## Elevation & Depth

The shown WPF theme does not define a shadow vocabulary. Surface tone, 1 DIP borders, 5 DIP splitters, alternating rows, and tab underlines establish hierarchy. The interface does not rely on floating cards or decorative charts.

## Shapes

Buttons and combo-box frames have a restrained 3 DIP corner radius and 1 DIP border. The scrollbar thumb has a 2 DIP corner radius. Tables, rails, inspector edges, text fields, and section containers otherwise read as straight-edged work surfaces. Focus thickens the button/text-field border to 2 DIP; selected rows and active navigation use color plus an explicit border or text context.

## Components

### Command bar and navigation

The top bar carries the Lodestar identity and short global actions. The rail uses left-aligned navigation buttons with transparent rest state, graphite hover, and mint-edged active state. The project finder and adjacent sort/history controls stay in the rail. A 24 DIP status line reports the last read or operation beneath the working panes.

### Tables and lists

`DataGrid` rows and column headers are 28 DIP high, with horizontal hairlines, alternating pane/chrome row fills, single-row selection, and resizable/reorderable columns. Project and record columns sort through native headers; adjacent controls group and reset views. The project rail and special activity/work lists use virtualized `ListBox` items. Group headings use the mint accent and chrome backing.

### Inspector readout

Readable, History, Raw, and Edit are adjacent actions in the contextual inspector. Readable content leads with recorded state and a summary, then expanded nested sections with labels, values, and data types. History and raw use a scrollable read-only text field for stored evidence. Source and saved-update labels make temporal claims explicit.

### Fields and guarded correction

Fields use graphite input fill, line borders, ink text, a mint caret, and a lighter focus border. The editor labels Name, Availability, Priority, present scalar fields, and Advanced data JSON. Multiline description/notes and scrollable JSON keep dense content usable. Discard and Review change appear before Save; the review text names changed fields and says that stored data changes only when Save is pressed. Invalid advanced JSON disables direct scalar editing until repaired.

### Focus and high contrast

Keyboard focus is visible on buttons, text fields, tabs, list items, tree items, grid rows, and scrollbars through focus-colored borders in the current styles. `Ctrl+F`, `F5`, `Ctrl+S` during editing, `Escape`, `Ctrl+Alt+Left`, and `Ctrl+Alt+0` are implemented shortcuts. When Windows high contrast changes, the application switches its dynamic brushes to `SystemColors` window, control, text, border, and highlight brushes, then restores the graphite values when high contrast ends. Actual appearance follows the user's Windows theme.

## Do's and Don'ts

### Do:

- **Do** keep dense, labeled WPF controls and expose source, saved time, and unknown state in text.
- **Do** keep the rail/main/inspector geometry resizable and the below-1180-DIP compact replacement behavior.
- **Do** preserve visible focus, Windows high contrast brushes, scrollable long evidence, and the Review then Save correction sequence.

### Don't:

- **Don't** add general PC CPU, memory, or disk telemetry to Lodestar Health.
- **Don't** imply unchecked integrity, current worker liveness, or filesystem freshness from stored records.
- **Don't** replace the native work surfaces with decorative cards, charts, or a web-specific layout system.

## Practical usability finish

Project scope is explicit: Project records and the activity/work/decision tabs require a selected project, with a nearby All projects return. Readable records lead with domain content; stored identity remains available in a collapsed section after content. Common editable fields precede the optional advanced JSON editor. Commands disclose where they can run, use native choices for described booleans/enums, and keep exact descriptors behind an expander. A selected row has an outline independent of its background so selection remains visible when system contrast brushes coincide. The graphite theme, native WPF controls and reviewed-save contract remain unchanged.
