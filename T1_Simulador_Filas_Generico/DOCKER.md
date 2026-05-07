## Docker image for the SiMA simulator

This folder expects two files in the repository root:

- `simulator.jar` — the simulator binary (from M3 | Modelagem orientada a eventos (Algoritmo de Simulação) (E1)).
- `model.yml` — the YAML model file (already present in this repo). The file must be named `model.yml`.


The provided `Dockerfile` is deliberately minimal: it copies `simulator.jar` and `model.yml` into the image and runs the JAR using the simulator's CLI form `run <model.yml>`.

Build the image:

```bash
docker build -t sima-simulator:latest .
```

Run the image (the image runs the simulator with the baked-in `model.yml`):

```bash
docker run --rm -it sima-simulator:latest
```

If you prefer to mount the host `model.yml` (so you can edit it without rebuilding the image):

```bash
docker run --rm -it -v "$(pwd)/model.yml:/app/model.yml:ro" sima-simulator:latest
```

The simulator JAR expects the `run` command. The `Dockerfile` entrypoint is equivalent to:

```bash
java -jar simulator.jar run /app/model.yml
```

Notes:

- Obtain `simulator.jar` from the M3 assignment (Modelagem orientada a eventos / Algoritmo de Simulação) and place it in the repository root as `simulator.jar` before building.
- The image uses OpenJDK 17 runtime (`eclipse-temurin:17-jre-jammy`). Change the base image if the JAR requires a different Java version.

Windows users / Git Bash note:

- If you run Docker from Git Bash (MSYS), absolute POSIX paths like `/app/model.yml` may be translated by the shell into a Windows path (for example `C:/Program Files/Git/app/model.yml`) before being passed to Docker. That causes the simulator inside the container to receive an invalid Windows-style path and error like:

	``ERROR: file 'C:/Program Files/Git/app/model.yml' not found!``

- Workarounds:
	- Use a relative path (recommended): the image `WORKDIR` is `/app`, so pass `model.yml` instead of `/app/model.yml`:

		```bash
		docker run --rm -it --entrypoint "" sima-simulator:latest java -jar simulator.jar run model.yml
		```

	- Run the `docker` command from PowerShell or CMD (they do not perform MSYS path translation):

		```powershell
		docker run --rm -it --entrypoint "" sima-simulator:latest java -jar simulator.jar run /app/model.yml
		```

	- Alternatively, avoid overriding `ENTRYPOINT` and let the image's `ENTRYPOINT` run the simulator; or use `//app/model.yml` (double slash) to prevent MSYS path conversion.

- If you need to inspect files inside the image first:

	```bash
	docker run --rm -it --entrypoint sh sima-simulator:latest -c "ls -la /app"
	```

