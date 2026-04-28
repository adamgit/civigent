# The "host.docker.internal" magic hostname

Port-mapping in devcontainers is still mostly incomplete as a feature (from Microsoft).

## Workaround: the magic hostname to let you access services on your local machine

This hostname maps to 'localhost' on your OS. This is frequently needed during development when testing external builds.

e.g. a common setup:

1. Run the devcontainer
2. Add a feature
3. Rebuild + run vitest tests
4. Trigger a rebuild to Github
5. In a separate container/deployment on your local machine: download the public container
6. Test that the feature has landed and works **outside** the dev environment

...but within the devcontainer number 6 in VScode is only possible (and VSCode forked IDEs) if you use an undocumented bug in VSCode that can magically setup a port tunnel. We cannot find any documentation on this, and don't know how/why some people got it working (and its proven impossible to reliably reproduce - may be it only worked in older versions of VSCode?).

OR: you enable the magic 'our host's hostname is host.docker.internal' setting in devcontainer.json

This was the least invasive workaround I've found so far that would let developers efficiently test both local dev changes and live builds through the full public infra, and fix bugs quickly.
