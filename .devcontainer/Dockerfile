FROM mcr.microsoft.com/devcontainers/javascript-node:24-bookworm

# Match backend/quickstart runtime needs: search shells out to `rg`.
# (git and openssh-client are already present on this base image.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep \
 && rm -rf /var/lib/apt/lists/*
