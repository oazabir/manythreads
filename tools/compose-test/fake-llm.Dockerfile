# syntax=docker/dockerfile:1
# The repository's fake LLM (tools/fake-llm) as a container, for the Docker Compose install's own test only (deploy/compose/docker-compose.test.yml).
# Build context = repo root; the file next to this one lists what is copied.
FROM node:22-slim
WORKDIR /app
COPY tools/fake-llm/package.json tools/fake-llm/package.json
COPY tools/fake-llm/src tools/fake-llm/src
RUN npm install --prefix /app/tools/fake-llm --no-save --no-audit --no-fund tsx@4
WORKDIR /app/tools/fake-llm
USER node
EXPOSE 4010
CMD ["node_modules/.bin/tsx", "src/cli.ts"]
