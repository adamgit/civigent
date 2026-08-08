# Recipes

Common tasks that may not be immediately obvious, or are not standard/required for most installations.

# Alternative installations

## Run multiple Civigent instances behind one Caddy proxy

Use this recipe to run several Civigent instances on one Docker host, with a different domain for each instance and one shared Caddy reverse proxy.

Example:

```text
wiki.example.com       → Civigent instance A
demo-1.example.com         → Civigent instance B
```

Both DNS records must point to the Docker host. TCP ports 80 and 443 must be reachable from the internet.

### 1. Create the shared Docker network

Run this once on the host:

```bash
docker network create caddy_proxy
```

This network allows the shared Caddy container to reach Civigent containers belonging to separate Compose projects.

### 2. Create a directory for each Civigent instance

For example:

```text
/srv/
├── app-wiki/
├── demo-1/
└── shared-caddy/
```

Copy the contents of the repository's `quickstart/` directory into each Civigent directory.

For each instance:

```bash
cp .env.example .env
mkdir -p wiki-data snapshots backup-secrets
```

### 3. Configure each instance

Set the instance's public hostname and URL in its `.env`.

Instance A:

```env
KS_EXTERNAL_HOSTNAME=wiki.example.com
KS_OIDC_PUBLIC_URL=https://wiki.example.com
KS_AUTH_SECRET=<generate-with-openssl-rand-hex-32>
```

Instance B:

```env
KS_EXTERNAL_HOSTNAME=demo-1.example.com
KS_OIDC_PUBLIC_URL=https://demo-1.example.com
KS_AUTH_SECRET=<generate-with-openssl-rand-hex-32>
```

Configure the remaining authentication settings as described in the Deployment Guide.

Generate a separate secret for each instance:

```bash
openssl rand -hex 32
```

### 4. Connect each instance to the proxy network

In each Civigent `compose.yaml`, remove the host-facing `ports` mapping:

```yaml
ports:
  - "${PORT:-8080}:3000"
```

Replace it with an internal port and a unique network alias.

Instance A:

```yaml
services:
  backend:
    restart: unless-stopped

    expose:
      - "3000"

    networks:
      caddy_proxy:
        aliases:
          - app-wiki

    environment:
      KS_EXTERNAL_PORT: "443"
      KS_EXTERNAL_HOSTNAME: ${KS_EXTERNAL_HOSTNAME:-localhost}

      # Keep the remaining quickstart environment entries unchanged.

networks:
  caddy_proxy:
    external: true
```

Instance B:

```yaml
services:
  backend:
    restart: unless-stopped

    expose:
      - "3000"

    networks:
      caddy_proxy:
        aliases:
          - demo-1

    environment:
      KS_EXTERNAL_PORT: "443"
      KS_EXTERNAL_HOSTNAME: ${KS_EXTERNAL_HOSTNAME:-localhost}

      # Keep the remaining quickstart environment entries unchanged.

networks:
  caddy_proxy:
    external: true
```

Keep the existing image, volume mounts and other environment entries from the quickstart Compose file.

Both containers can use internal port 3000. They are separate containers and are distinguished by their network aliases.

Do not publish port 3000 on the host.

### 5. Create the shared Caddy Compose project

Create `/srv/shared-caddy/compose.yaml`:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    container_name: caddy
    restart: unless-stopped

    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"

    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

    networks:
      - caddy_proxy

networks:
  caddy_proxy:
    external: true

volumes:
  caddy_data:
  caddy_config:
```

Only the shared Caddy container publishes host ports 80 and 443.

### 6. Create the Caddyfile

Create `/srv/shared-caddy/Caddyfile`:

```caddyfile
wiki.example.com {
    reverse_proxy app-wiki:3000
}

demo-1.example.com {
    reverse_proxy demo-1:3000
}
```

Add another site block for each additional Civigent instance.

### 7. Start the instances

Start each Civigent project:

```bash
cd /srv/app-wiki
docker compose up -d

cd /srv/demo-1
docker compose up -d
```

Start Caddy:

```bash
cd /srv/shared-caddy
docker compose up -d
```

### 8. Verify the deployment

Confirm that all containers joined the shared network:

```bash
docker network inspect caddy_proxy \
  --format '{{range .Containers}}{{println .Name .IPv4Address}}{{end}}'
```

The output should include Caddy and both Civigent backend containers.

Validate the Caddyfile:

```bash
docker exec caddy caddy validate \
  --config /etc/caddy/Caddyfile \
  --adapter caddyfile
```

Check Caddy's logs:

```bash
docker logs caddy --tail 100
```

Finally, open each public URL:

```text
https://wiki.example.com
https://demo-1.example.com
```

Caddy obtains and renews the HTTPS certificates automatically.

### Migrating from a per-instance proxy

***NOTE:*** If you were already using Caddy for a single instance.

Before starting shared Caddy, remove any existing container that already publishes ports 80 or 443:

```bash
docker ps --filter publish=80
docker ps --filter publish=443
```

Stop and remove the old proxy container:

```bash
docker rm -f <old-proxy-container>
```

A container removed from a Compose file before `docker compose down` may remain as an orphan. Running the following from the old project directory removes such containers:

```bash
docker compose down --remove-orphans
```


# Synching / transferring data

## Copy documents from one Civigent instance to another

This works when both instances share the same host (e.g. multiple Docker Compose stacks on the same server). It uses the Snapshots feature on the source and the Import feature on the target.

### Prerequisites

- Both instances are running on the same server.
- The source instance has snapshots enabled (`KS_SNAPSHOT_ENABLED=true`, which is the default). Check **Admin → Configuration** or the Snapshots page.

### Steps

**1. Take a snapshot on the source instance**

Go to the source instance's **Snapshots** page (Admin → Snapshots). Verify a recent snapshot exists, or click **Snapshot now** to create one. Snapshots are assembled `.md` files under the configured snapshot root. In quickstart, the default host folder is `./snapshots`.

**2. Create a new import on the target instance**

Go to the target instance's **Imports** page. Click **New import**. The page will display the staging folder path for that import (something like `/app/data/import-staging/<uuid>/`). Note this path — you will copy files into it.

**3. Copy files from the source snapshot folder into the staging folder**

On the server, copy the documents you want from the source snapshot folder into the target's staging folder. For example, to copy everything:

```bash
# Copy markdown files into the target's staging folder
cp -r /path/to/source/snapshots/. /path/to/target/data/import-staging/<uuid>/
```

You can also copy only a subfolder if you don't want to import everything:

```bash
cp -r /path/to/source/snapshots/my-subfolder/ /path/to/target/data/import-staging/<uuid>/
```

> **Tip:** The exact data paths depend on your Docker volume mounts. If both stacks use named volumes, use `docker run --rm -v source_data:/src -v target_data:/dst alpine cp -r /src/snapshots/. /dst/import-staging/<uuid>/` to copy between volumes without knowing host paths.

**4. Verify files arrived**

Back on the target's Imports page, click **Refresh** next to the import. You should see the list of `.md` files that were copied in.

**5. Import**

Enter a description (e.g. "Import docs from project X") and click **Import**. The documents will be written through the proposal system — auto-committed if all sections pass the governance threshold, or queued as a pending proposal if any section requires human approval.

---
