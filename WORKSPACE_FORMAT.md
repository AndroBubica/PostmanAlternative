# API Lantern Workspace Format

API Lantern workspaces are ordinary UTF-8 JSON files. The root manifest is
`api-lantern.json`:

```json
{ "format": "api-lantern-workspace", "version": 1 }
```

## Layout

```text
workspace/
  api-lantern.json
  settings.json
  globals.json
  collections/<id>.json
  requests/<id>.json
  environments/<id>.json
  history/<id>.json
  private/secrets.enc
```

IDs are portable strings. References use IDs and never absolute paths, except
for user-selected request body files. Writers must replace files atomically.
Unknown fields should be preserved where practical.

`private/secrets.enc` is an AES-256-GCM encrypted JSON object. Its key is
derived from the user's password with Argon2. Portable ZIP exports omit the
entire `private` directory and clear secret values and request credentials.

Variables resolve from lowest to highest priority: global, collection,
environment, temporary. Disabled variables are ignored.
