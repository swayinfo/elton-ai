/* ============================================================
 *  What the assistant knows about Obsidian
 *
 *  Every one of these rides inside main.js. That is not a size
 *  decision, it is the only option: a release carries three files
 *  and the developer policies forbid a plugin fetching more of
 *  itself afterwards. Anything the assistant needs in order to
 *  write a working file has to already be here when BRAT copies
 *  those three files across.
 *
 *  They are offered ONLY for plugins the vault actually has. A
 *  guide to Dataview in a vault without Dataview is an invitation
 *  to write a query that renders as a grey box — the same failure
 *  as the Kanban board that came out as plain text, which is what
 *  these exist to stop.
 *
 *  Kept short on purpose. A skill is loaded into a live
 *  conversation, so every line is paid for in tokens and in
 *  latency; what belongs here is the part a model reliably gets
 *  wrong, not the part it already knows.
 * ========================================================== */

/**
 * `plugin` is the community plugin id this guide is about — the skill is
 * hidden unless that plugin is installed. No id means core Obsidian.
 */
const BUILTIN_SKILLS = [
  {
    name: "obsidian-notes",
    description: "How a note is put together: properties, links, callouts, tasks, embeds. Read before writing or restructuring any note.",
    text: `A note is markdown with a few Obsidian-specific parts.

PROPERTIES (frontmatter). The very first thing in the file, between --- lines.
Nothing may precede it, not even a blank line, or it renders as text.
---
tags:
  - project
created: 2026-08-03
related:
  - "[[Another note]]"
---
A link inside properties MUST be quoted: - "[[Note]]". Unquoted it is a YAML
parse error and every property in the note is silently dropped.

LINKS. [[Note name]] links by name, wherever the file sits. [[Note|shown text]]
renames the link. [[Note#Heading]] targets a heading, [[Note#^block-id]] a
block. Never write a path when a name will do — a name survives the file moving.

CALLOUTS. A blockquote with a type in brackets:
> [!note] Optional title
> The body.
Types: note, tip, info, todo, success, question, warning, failure, danger,
example, quote, abstract. Add - after the type for a callout that starts folded
(> [!warning]- ...), or + for one that starts open.

TASKS. - [ ] open, - [x] done. Nested under each other with two spaces.
They are real checkboxes in reading view and click to toggle.

EMBEDS. ![[Note]] embeds the whole note, ![[Note#Heading]] one section,
![[image.png]] an image. ![[image.png|300]] sets a width.

HEADINGS. One # per level, a space after it. Do not use bold text as a
heading — the outline, links to headings and folding all read # levels only.

WRITING FOR THIS VAULT. Match what is already there. Before creating a note in
a folder, read a neighbour and follow its properties and structure rather than
inventing a shape of your own.`,
  },

  {
    name: "kanban-boards",
    plugin: "obsidian-kanban",
    description: "The exact file a Kanban board has to be. Read before making or editing any board.",
    text: `A board is a normal .md file that the Kanban plugin renders as columns.
Three things decide whether it opens as a board or as plain text, and all
three are easy to get wrong:

1. The property kanban-plugin: board must be in the frontmatter. Without it
   the file is an ordinary note, however well-formed the rest is.
2. Every column is a level-2 heading: ## Name. Plain bold text is not a column.
3. The settings comment at the end must contain real JSON, with one
   list-collapse entry per column.

The whole file:

---
kanban-plugin: board
---

## Idea

- [ ] First card
- [ ] Second card

## In progress

- [ ] Card being worked on

## Done

%% kanban:settings
\`\`\`
{"kanban-plugin":"board","list-collapse":[false,false,false]}
\`\`\`
%%

CARDS are - [ ] lines under a column. A card may hold links, tags and dates
like any other markdown: - [ ] Write the brief [[Project]] #urgent.
A checked card - [x] shows as done.

Prefer the create_board tool over writing this by hand — it is here so you can
also READ and EDIT an existing board correctly. When editing, add cards under
the right ## heading and leave the frontmatter and the settings block alone.`,
  },

  {
    name: "dataview-queries",
    plugin: "dataview",
    description: "Live lists and tables built from the vault. Read before writing any dataview block.",
    text: `Dataview turns the vault into something you can query. A query is a
fenced block with the language "dataview":

\`\`\`dataview
TABLE created, status
FROM "1. Projects"
WHERE status != "done"
SORT created DESC
LIMIT 20
\`\`\`

FORMS. LIST (one line each), TABLE col, col (a table), TASK (checkboxes, still
clickable), CALENDAR date.

FROM picks the source: "Folder" for a folder, #tag for a tag, [[Note]] for
notes linking to it, and combinations with and / or. Omit FROM for the whole
vault, but only for small results.

FIELDS. Any property in the frontmatter is a field. So is inline key:: value
written in the body. file.name, file.link, file.mtime, file.folder and
file.tags always exist.

WHERE takes ordinary expressions: contains(file.name, "MOC"), date(today) - file.mtime < dur(7 days),
status = "active", !completed.

INLINE. \`= this.file.name\` prints one value in running text; \`$= dv.pages(...)\`
runs javascript, but only if the user has that switched on — prefer the plain form.

Two rules that save a lot of grief: the block renders only in reading view, and
a query with a typo shows an error box rather than nothing — so if the user
says "it is empty", the query ran and matched nothing, and the FROM is usually
what is wrong.`,
  },

  {
    name: "bases",
    description: "Obsidian's own database view (.base files). Read before making one.",
    text: `A .base file is Obsidian's built-in database over notes — the core
answer to what Dataview does, and it is a YAML file, not markdown.

filters:
  and:
    - file.inFolder("1. Projects")
    - status != "done"
views:
  - type: table
    name: Active
    order:
      - file.name
      - status
      - due
    sort:
      - property: due
        direction: ASC

Views are table or cards. Properties come from the notes' frontmatter, and
file.name, file.folder, file.mtime, file.tags are always available.
Functions used in filters: file.inFolder(), file.hasTag(), contains(),
date comparisons with today and duration literals.

A base can also be embedded in a note: ![[Projects.base]].

Prefer a base when the user wants something they will sort and filter
themselves; prefer dataview when they want a fixed list inside a note. If both
plugins are absent, write an ordinary list — never leave a code block that
renders as grey text.`,
  },

  {
    name: "templater-templates",
    plugin: "templater-obsidian",
    description: "Templates with live values — dates, prompts, file names. Read before writing a template.",
    text: `Templater fills a template in as it is inserted. Its tags look like
<% ... %> and run at insert time.

Common ones:
<% tp.date.now("DD-MM-YYYY") %>            today
<% tp.date.now("DD-MM-YYYY", -1) %>        yesterday
<% tp.file.title %>                        the new file's name
<% tp.file.cursor() %>                     where the cursor lands afterwards
<% tp.system.prompt("Title?") %>           asks the user
<% tp.file.include("[[Other template]]") %> pulls another template in

<%* ... %> is a javascript block that outputs nothing by itself; use tR += to
add text from it.

Writing a template into a note the user will USE is different from writing one
they will STORE. In a stored template the tags stay as tags — do not evaluate
them yourself and do not "helpfully" replace <% tp.date.now() %> with today's
date, or the template only ever produces the day you wrote it.`,
  },

  {
    name: "excalidraw-drawings",
    plugin: "obsidian-excalidraw-plugin",
    description: "Drawings and diagrams stored as notes. Read before creating or editing one.",
    text: `An Excalidraw drawing is a .md file with excalidraw-plugin: parsed in
its frontmatter and two sections: "# Text Elements" and "# Drawing" with a
compressed JSON block.

Do NOT try to author the drawing JSON by hand — it carries ids, versions and
bindings that will not survive being invented, and a malformed file opens as an
error rather than a canvas.

What you CAN do safely:
- create the note that will hold a drawing and tell the user to open it with
  the "Excalidraw: Create new drawing" command;
- read the "# Text Elements" section, which is plain text, to answer questions
  about what a drawing says;
- embed an existing drawing in another note with ![[Drawing.md]].

If the user wants a diagram in a note rather than a canvas, a mermaid block is
usually the better answer — it is core Obsidian and it is text you can edit.`,
  },

  {
    name: "charts",
    plugin: "obsidian-charts",
    description: "Bar, line and pie charts inside a note.",
    text: `A chart is a fenced block with the language "chart":

\`\`\`chart
type: bar
labels: [Mon, Tue, Wed, Thu, Fri]
series:
  - title: Words written
    data: [1200, 800, 0, 1500, 2100]
\`\`\`

type: bar, line, pie, doughnut, radar, polarArea.
Useful extras: stacked: true, fill: false, tension: 0.3 for smooth lines,
labelColors: true, width: 80%.

Keep the numbers honest: only chart values that are actually in the user's
notes, and say where they came from. A chart made of plausible-looking numbers
is the most convincing way to be wrong.`,
  },

  {
    name: "meta-bind-inputs",
    plugin: "obsidian-meta-bind-plugin",
    description: "Buttons, toggles and inputs bound to a note's properties.",
    text: `Meta Bind puts real controls in a note and binds them to frontmatter,
so ticking a box edits the property.

Inline, in running text:
\`INPUT[toggle:done]\`
\`INPUT[text:title]\`
\`INPUT[slider(minValue(1), maxValue(10)):score]\`
\`INPUT[select(option(low), option(high)):priority]\`
\`INPUT[datePicker:due]\`

The name after the colon is the frontmatter property it writes to. That
property should already exist in the note's properties, or the first change
creates it with a type you did not choose.

\`VIEW[{property}]\` displays a value without a control.

Blocks use the same syntax in a fenced meta-bind block. Keep controls next to
what they describe — a row of inputs at the top of a note with no labels is
worse than plain text.`,
  },

  {
    name: "diagrams-mermaid",
    description: "Flowcharts, sequences and timelines in core Obsidian, no plugin needed.",
    text: `Mermaid is built into Obsidian. A fenced block with the language
"mermaid" renders as a diagram, in every vault, with nothing installed.

\`\`\`mermaid
flowchart TD
  A[Idea] --> B{Worth doing?}
  B -- yes --> C[Project]
  B -- no --> D[Someday]
\`\`\`

Kinds worth knowing: flowchart TD / LR, sequenceDiagram, gantt, mindmap,
timeline, classDiagram, stateDiagram-v2, pie.

Two things that break diagrams in Obsidian specifically: node text containing
brackets or quotes needs to be wrapped — A["Text (with brackets)"] — and a
wiki link inside a node does not work; put the link in the surrounding note.

This is the safe default when the user wants a picture of how something fits
together. It needs no plugin, it is diffable text, and it survives sync.`,
  },
];

/** The skills that make sense in THIS vault, plus any the proxy adds. */
function builtinSkillsFor(app) {
  const has = (id) => {
    if (!id) return true;
    const p = app && app.plugins;
    if (!p) return false;
    return !!((p.plugins && p.plugins[id]) || (p.enabledPlugins && p.enabledPlugins.has && p.enabledPlugins.has(id)));
  };
  return BUILTIN_SKILLS.filter((s) => has(s.plugin))
    .map((s) => ({ name: s.name, description: s.description, builtin: true }));
}

function builtinSkillText(name) {
  const s = BUILTIN_SKILLS.find((x) => x.name === name);
  return s ? s.text : "";
}
