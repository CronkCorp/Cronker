FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
# Attachments are kept here (CRONK_ATTACHMENTS_DIR); Compose mounts a volume on it.
RUN mkdir -p /app/data/attachments && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "dist/server/main.js"]
