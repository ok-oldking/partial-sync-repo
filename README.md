# Partial Repo Sync Action

This GitHub Action synchronizes a specified subset of files and Git state from a source repository to one or more target repositories. It is triggered by a Git tag and intelligently generates commit messages, syncs special tags (like `lts`), and prunes stale tags from the target repositories.

This is ideal for scenarios where you maintain a "source of truth" repository and need to publish sanitized or specific parts of it—such as build artifacts or documentation—to public or downstream repositories.

## Key Features

-   **Partial File & Directory Syncing**: Copies a specific list of files and directories to target repositories.
-   **Intelligent Commit Messages**: Generates a detailed commit message by summarizing the changes between the last synced tag and the current tag. This message is also available as an output.
-   **Full Tag Synchronization**:
    -   Deletes tags from target repos that no longer exist in the source repo.
    -   Copies the primary version tag (e.g., `v1.2.3`).
    -   Moves any associated special tags (e.g., `lts`, `stable`) to the new commit.
-   **Multi-Repository Support**: Syncs a single source to multiple target repositories in one workflow run.

## Inputs

| Input         | Description                                                                                              | Required |
| ------------- | -------------------------------------------------------------------------------------------------------- | -------- |
| `repos`       | A multiline list of target repository URLs to sync to.                                                   | `true`   |
| `sync_list`   | Path to a file in the source repository that lists files and directories to sync, one per line.            | `true`   |
| `tag`         | The Git tag in the source repository that triggers the sync. Use `github.ref_name` in workflows.         | `true`   |

## Outputs

| Output        | Description                                                                   |
| ------------- | ----------------------------------------------------------------------------- |
| `changes`     | The generated commit message containing the summary of changes since the last synced tag. |

## Permissions

This action authenticates using the `GITHUB_TOKEN` provided by the workflow runner. The job must be granted `contents: write` permissions to push changes to repositories within the same organization.

If you are syncing to a repository outside of your organization, you must use a Personal Access Token (PAT) with the appropriate `repo` scope. The PAT should be stored as a secret and used to configure Git's credentials for the job before this action runs.

## Usage Example

Here is an example workflow that runs when a new tag matching `v*` is pushed. It syncs files to two repositories and then uses the `changes` output in a subsequent step.

1.  **Create your sync list file.** In your source repository, create a file named `sync_files.txt`:

    ```text
    # sync_files.txt
    dist
    LICENSE
