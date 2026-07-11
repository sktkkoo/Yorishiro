# vendored pack manifest schema

`pack-manifest.schema.json` is a **vendored, human-readable copy** of the pack
store's generated JSON Schema (source of truth:
`CharminalPackStore/packages/schema` → `z.toJSONSchema()` output, guarded there
by `json-schema-parity.test.ts`).

It exists only so the bundled-manifest conformance test
(`../bundled-manifest-conformance.test.ts`) can check that every bundled pack
manifest satisfies the store's schema, **without** depending on the store repo.

## Updating

When the store schema changes, re-copy the generated file:

```
cp ../../../../CharminalPackStore/packages/schema/schemas/pack-manifest.schema.json ./pack-manifest.schema.json
```

## Intended replacement

This vendored copy is an interim transport. Once `@yorishiro/pack-schema` is
published to npm, replace it with a normal versioned dependency so there is a
single source of truth. See `docs/decisions/` / the pack store seeding plan.
