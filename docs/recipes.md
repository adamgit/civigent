# Recipes

Common tasks that may not be immediately obvious from the UI.

---

## Copy documents from one Civigent instance to another

This works when both instances share the same host (e.g. multiple Docker Compose stacks on the same server). It uses the Snapshots feature on the source and the Import feature on the target.

### Prerequisites

- Both instances are running on the same server.
- The source instance has snapshots enabled (`KS_SNAPSHOT_ENABLED=true`, which is the default). Check **Admin → Configuration** or the Snapshots page.

### Steps

**1. Take a snapshot on the source instance**

Go to the source instance's **Snapshots** page (Admin → Snapshots). Verify a recent snapshot exists, or click **Snapshot now** to create one. Snapshots are saved to the data volume at `snapshots/` — visible as a timestamped `.tar.gz` file.

**2. Create a new import on the target instance**

Go to the target instance's **Imports** page. Click **New import**. The page will display the staging folder path for that import (something like `/app/data/import-staging/<uuid>/`). Note this path — you will copy files into it.

**3. Copy files from the source snapshot into the staging folder**

On the server, extract the documents you want from the source snapshot into the target's staging folder. For example, to copy everything:

```bash
# Extract snapshot contents to a temp directory
tar -xzf /path/to/source/data/snapshots/<snapshot>.tar.gz -C /tmp/snapshot-extract/

# Copy markdown files into the target's staging folder
cp -r /tmp/snapshot-extract/content/. /path/to/target/data/import-staging/<uuid>/
```

You can also copy only a subfolder if you don't want to import everything:

```bash
cp -r /tmp/snapshot-extract/content/my-subfolder/ /path/to/target/data/import-staging/<uuid>/
```

> **Tip:** The exact data paths depend on your Docker volume mounts. If both stacks use named volumes, use `docker run --rm -v source_data:/src -v target_data:/dst alpine cp -r /src/snapshots/. /dst/import-staging/<uuid>/` to copy between volumes without knowing host paths.

**4. Verify files arrived**

Back on the target's Imports page, click **Refresh** next to the import. You should see the list of `.md` files that were copied in.

**5. Import**

Enter a description (e.g. "Import docs from project X") and click **Import**. The documents will be written through the proposal system — auto-committed if all sections pass the governance threshold, or queued as a pending proposal if any section requires human approval.

---
