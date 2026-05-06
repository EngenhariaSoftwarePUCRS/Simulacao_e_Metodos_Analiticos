FROM eclipse-temurin:17-jre-jammy

# Working directory
WORKDIR /app

# Expect `simulator.jar` and `model.yml` to be present in the build context (repository root)
COPY simulator.jar /app/simulator.jar
COPY model.yml /app/model.yml

# Run the simulator and pass the model file as argument (if the JAR expects it).
# If the JAR reads model.yml from the current directory automatically, the arg is harmless.
ENTRYPOINT ["java", "-jar", "/app/simulator.jar", "run", "/app/model.yml"]
