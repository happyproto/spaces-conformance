# The harness container: Node 24 with the suite's dependencies installed for
# Linux at build time, because the stack network has no egress. The source is
# bind-mounted at /suite at run time; node_modules comes from the image.
FROM node:24-bookworm-slim
RUN npm install -g bun@1.4.2
WORKDIR /suite
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
