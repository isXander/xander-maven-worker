# Xander's Maven Worker

A Maven Server in the form of a Cloudflare Worker, using Cloudflare R2 for storage.

## Features

- `maven-metadata.xml` fixing: Automatically generates and fixes `maven-metadata.xml` files when clients race to upload differing versions of the same artifact
  - Waits 5 seconds after the last upload per-artifact and then regenerates the `maven-metadata.xml` file
  - Uses Durable Objects
- Web UI for browsing uploaded artifacts, at `/web/`
  - Uses HTMX, extremely minimal and fast web UI with caching
- Optionally enforceable immutability
- Configures Cache-Control headers:
  - Immutable data: `public, max-age=1800, s-maxage=31536000`
  - Mutable data: `public, max-age=60, s-maxage=300`
- Autogenerates checksums for uploaded artifacts
- Ignores uploaded checksums in favor of the generated ones
- Supports Range requests and conditional requests
- Supports Basic Authentication
  - Stored credentials in D1 database, hashed with SHA-256 and peppered
  - Fast, lower-security hashing algorithm (SHA-256) used as passwords are expected to be high entropy and randomised, not memorable
  - No permissions system; a credential has full read/write access to all repositories
  - Currently credentials cannot be managed remotely, you must edit the D1 database directly; password hashes use `sha256(password + pepper)`
- Multiple repositories; each repository is a separate Cloudflare R2 bucket

## Configuration

Most configuration is done via environment variables found in `"vars":` in the `wrangler.jsonc` file.

- `REPOSITORIES`: A comma-separated list of repository names to use, should match the binding of the R2 bucket
- `CHECKSUM_VALIDATION`: (true/false) Whether to validate uploaded checksums if auto-generation is disabled
- `CHECKSUM_AUTOGENERATION`: (true/false) Whether to automatically generate checksums for uploaded artifacts
- `ALLOW_OVERWRITES`: (true/false) Whether to allow overwriting of existing artifacts

You also need to set the `PEPPER` environment secret.

## Tech Stack

- **Cloudflare Workers / Durable Objects**
- **Cloudflare D1** for storing credentials
- **Cloudflare R2** for storing artifacts
- **Hono** for routing
- **HTMX** for server-side rendering
- No build steps
