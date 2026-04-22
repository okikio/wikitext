# Diagnostic Anchors

Diagnostics live beside the tree, not inside it.

That means the parser needs a small way to point back from a diagnostic to the
relevant region of the final materialized tree.

That design works best because diagnostics are also range-first. They start as
parser findings about positions in the original source, then carry a narrow
tree-local anchor so tooling can reconnect those findings to one materialized
view.

## What an anchor is

Today each diagnostic carries an `anchor`.

That anchor is intentionally narrow. It is a tree-path snapshot to the nearest
materialized node around the diagnostic point.

```text
root
├─ paragraph        path [0]
│  └─ bold          path [0, 0]
└─ table            path [1]
```

That shape is enough for tooling to answer practical questions such as:

- which node is nearest to this diagnostic?
- where in the final tree should I highlight or inspect?

The important part is what the anchor does not replace. It does not replace the
source range. The diagnostic still fundamentally refers to a location in the
original text. The anchor just helps map that finding into one tree.

## Why diagnostics are not tree nodes

The AST is meant to represent document structure and meaning.

Diagnostics are parser findings about malformed input or continuation events.
They are important, but they are not normal content nodes.

Keeping them beside the tree instead of inside it makes the AST easier to use
for normal document transforms while still letting tooling recover the relevant
location when needed.

That separation also keeps the tree from pretending diagnostics are ordinary
content. A malformed span can still be source-backed text or a recovered
structure in the tree while the diagnostic remains a parallel parser finding.

## Current helper path

Callers do not have to resolve anchors by hand.

Use:

- `resolveDiagnosticAnchor(tree, diagnostic.anchor)`
- `locateDiagnostic(tree, diagnostic)`

These helpers turn the stored path back into a concrete node, parent, and child
index.

## What anchors do not promise yet

Current anchors are tree-local, not edit-stable.

They resolve against one final materialized tree. They do not yet promise:

- stable identity across later edits
- slot semantics across reparses
- session-backed cross-edit anchor durability

That stronger anchor model belongs to later session and edit-tracking work.

Until then, the safest thing a caller can trust is:

- the diagnostic's source range is authoritative
- the anchor is a helper for one final materialized tree