# magequery-action

Install [magequery](https://github.com/cresset-tools/magequery) and run it against a Magento 2
or Mage-OS project. magequery reads the source tree directly, so static commands do not need a
database, generated code, or a Magento bootstrap.

## Usage

Install the project dependencies first, then run a check. Bougie is a fast Composer-compatible
package and PHP toolchain manager; `bougie sync` prepares `vendor/` for magequery.

```yaml
- uses: actions/checkout@v4
- uses: cresset-tools/setup-bougie@v1
- run: bougie sync
- uses: cresset-tools/magequery-action@v1
```

The default command is `magequery doctor`, which exits non-zero for broken static wiring.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `version` | `latest` | Magequery release to install, such as `0.7.0`. |
| `checksum` | release sidecar | Optional SHA-256 checksum for the downloaded archive. |
| `args` | `doctor` | Any magequery command and its arguments. |
| `root` | `.` | Magento project root. |
| `github-token` | `${{ github.token }}` | Token used to resolve and download releases. |

Examples:

```yaml
# Fail if app/etc/config.php and the modules on disk disagree.
- uses: cresset-tools/magequery-action@v1
  with:
    args: modules --check

# Check only unregistered application code, while still validating all references.
- uses: cresset-tools/magequery-action@v1
  with:
    args: doctor --source app

# Query a specific class with a pinned magequery version.
- uses: cresset-tools/magequery-action@v1
  with:
    version: 0.7.0
    args: 'di Magento\Catalog\Api\ProductRepositoryInterface'
```

Downloaded archives are verified against their release SHA-256 sidecars before extraction and
stored in the GitHub runner tool cache. `doctor` and `modules --check` findings are emitted as
GitHub annotations with file and line information when available.

## Output

`magequery-version` is the installed magequery version.
