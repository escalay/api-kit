FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod
COPY src src
COPY guide guide
COPY container container
ENV PORT=80 STATE_DIR=/state
EXPOSE 80
HEALTHCHECK CMD wget -qO- http://127.0.0.1/api/health || exit 1
ENTRYPOINT ["/app/container/entrypoint.sh"]
